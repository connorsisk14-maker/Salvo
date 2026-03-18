import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildRuntimeEnv, runPreflight } from "./prod-preflight.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launchdTemplateDir = path.join(rootDir, "deploy", "launchd");
const services = [
  {
    label: "com.salvo.orchestrator-api",
    templateFile: "com.salvo.orchestrator-api.plist"
  },
  {
    label: "com.salvo.orchestrator-daemon",
    templateFile: "com.salvo.orchestrator-daemon.plist"
  },
  {
    label: "com.salvo.research-daemon",
    templateFile: "com.salvo.research-daemon.plist"
  }
];

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function resolvePnpmBin() {
  const fallback = path.join(rootDir, "node_modules", ".bin", "pnpm");
  const fromPath = spawnSync("which", ["pnpm"], {
    encoding: "utf8"
  });
  const resolved = fromPath.status === 0 ? fromPath.stdout.trim() : "";
  return resolved || fallback;
}

function launchctl(args, options = {}) {
  const result = spawnSync("launchctl", args, {
    encoding: "utf8"
  });
  if (result.status !== 0 && !options.allowFailure) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    throw new Error(
      `launchctl ${args.join(" ")} failed: ${stderr || stdout || `exit ${result.status}`}`
    );
  }
  return result;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: options.stdio ?? "inherit",
    env: options.env ?? process.env,
    encoding: "utf8"
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}`
    );
  }
  return result;
}

function collectServiceEnv(env) {
  const allowedKeys = Object.keys(env).filter((key) => key.startsWith("SALVO_"));
  if (typeof env.VITE_SALVO_API_URL === "string" && env.VITE_SALVO_API_URL.trim().length > 0) {
    allowedKeys.push("VITE_SALVO_API_URL");
  }
  if (typeof env.TZ === "string" && env.TZ.trim().length > 0) {
    allowedKeys.push("TZ");
  }
  const values = {};
  for (const key of new Set(allowedKeys)) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) {
      values[key] = value;
    }
  }
  values.NODE_ENV = "production";
  return values;
}

function buildEnvVarXmlBlock(envValues) {
  const keys = Object.keys(envValues).sort((a, b) => a.localeCompare(b));
  if (keys.length === 0) {
    return "";
  }
  return keys
    .map((key) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(envValues[key])}</string>`)
    .join("\n");
}

async function renderPlist(input) {
  const templatePath = path.join(launchdTemplateDir, input.templateFile);
  const template = await readFile(templatePath, "utf8");
  return template
    .replaceAll("__ROOT_DIR__", xmlEscape(input.rootDir))
    .replaceAll("__PNPM_BIN__", xmlEscape(input.pnpmBin))
    .replaceAll("__LOG_DIR__", xmlEscape(input.logDir))
    .replaceAll("__PATH__", xmlEscape(input.pathValue))
    .replaceAll("__ENV_VARS__", input.envVarXmlBlock);
}

async function waitForApiHealth(port) {
  const url = `http://localhost:${port}/health`;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return true;
      }
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const skipMigrations = args.has("--skip-migrations");

  const preflight = await runPreflight();
  if (!preflight.ok) {
    throw new Error("Preflight failed. Run `pnpm prod:preflight` for detailed diagnostics.");
  }

  const env = await buildRuntimeEnv();
  const uid = process.getuid?.();
  if (typeof uid !== "number") {
    throw new Error("Unable to resolve current user id for launchctl GUI domain.");
  }
  const domain = `gui/${uid}`;
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const logDir = path.join(env.SALVO_WORKSPACE_ROOT, "logs", "prod");
  await mkdir(launchAgentsDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  if (!skipMigrations) {
    console.log("[prod-up] applying migrations...");
    runCommand("pnpm", ["db:migrate"], { env });
  } else {
    console.log("[prod-up] skipping migrations (--skip-migrations)");
  }

  const pnpmBin = resolvePnpmBin();
  const serviceEnv = collectServiceEnv(env);
  const pathValue = [path.dirname(pnpmBin), env.PATH ?? process.env.PATH ?? "/usr/bin:/bin"]
    .filter(Boolean)
    .join(":");
  const envVarXmlBlock = buildEnvVarXmlBlock(serviceEnv);

  const installed = [];
  for (const service of services) {
    const rendered = await renderPlist({
      templateFile: service.templateFile,
      rootDir,
      pnpmBin,
      logDir,
      pathValue,
      envVarXmlBlock
    });
    const destination = path.join(launchAgentsDir, `${service.label}.plist`);
    await writeFile(destination, rendered, "utf8");

    launchctl(["bootout", `${domain}/${service.label}`], { allowFailure: true });
    launchctl(["bootstrap", domain, destination]);
    launchctl(["kickstart", "-k", `${domain}/${service.label}`]);
    installed.push(destination);
    console.log(`[prod-up] started ${service.label}`);
  }

  const apiPort = Number(env.SALVO_API_PORT ?? 8787);
  const healthy = await waitForApiHealth(apiPort);
  if (!healthy) {
    throw new Error(`API health check failed at http://localhost:${apiPort}/health`);
  }

  console.log("[prod-up] production services are up");
  console.log(`[prod-up] launchd domain: ${domain}`);
  console.log(`[prod-up] installed plists: ${installed.join(", ")}`);
  console.log(`[prod-up] api health: http://localhost:${apiPort}/health`);
}

void main().catch((error) => {
  console.error(`[prod-up] FAIL: ${error.message}`);
  process.exit(1);
});
