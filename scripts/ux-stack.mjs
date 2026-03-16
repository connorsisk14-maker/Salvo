import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { loadSecretsIntoEnv } from "../packages/shared/src/secrets.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFilePath = path.join(rootDir, ".env");

function parseDotEnv(source) {
  const output = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const idx = line.indexOf("=");
    if (idx === -1) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    output[key] = value.replace(/^['"]|['"]$/g, "");
  }
  return output;
}

async function loadEnvFromFile() {
  try {
    const raw = await readFile(envFilePath, "utf8");
    return parseDotEnv(raw);
  } catch {
    return {};
  }
}

async function runtimeEnv() {
  const dotEnv = await loadEnvFromFile();
  const merged = {
    ...process.env,
    ...dotEnv
  };
  await loadSecretsIntoEnv(merged);

  const databaseUrl = merged.SALVO_DATABASE_URL ?? merged.SALVO_TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Missing SALVO_DATABASE_URL (or SALVO_TEST_DATABASE_URL).");
  }

  const apiPort = Number(merged.SALVO_API_PORT ?? 8787);
  const workspaceRoot =
    merged.SALVO_WORKSPACE_ROOT ?? path.join(rootDir, ".salvo-workspace");

  return {
    ...merged,
    SALVO_DATABASE_URL: databaseUrl,
    SALVO_API_PORT: String(apiPort),
    SALVO_WORKSPACE_ROOT: workspaceRoot,
    VITE_SALVO_API_URL:
      merged.VITE_SALVO_API_URL ?? `http://localhost:${apiPort}`,
    SALVO_HEALTH_ORCHESTRATOR_STALE_SECONDS:
      merged.SALVO_HEALTH_ORCHESTRATOR_STALE_SECONDS ?? "15",
    SALVO_HEALTH_RESEARCH_STALE_SECONDS:
      merged.SALVO_HEALTH_RESEARCH_STALE_SECONDS ?? "45"
  };
}

function statePaths(env) {
  const stateDir = path.join(env.SALVO_WORKSPACE_ROOT, "dev");
  return {
    stateDir,
    pidFile: path.join(stateDir, "pids.json")
  };
}

async function readPidState(env) {
  const { pidFile } = statePaths(env);
  try {
    return JSON.parse(await readFile(pidFile, "utf8"));
  } catch {
    return null;
  }
}

async function writePidState(env, state) {
  const { stateDir, pidFile } = statePaths(env);
  await mkdir(stateDir, { recursive: true });
  await writeFile(pidFile, JSON.stringify(state, null, 2), "utf8");
}

function isPidRunning(pid) {
  if (!pid || Number.isNaN(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function killPidAndGroup(pid, signal) {
  let groupKilled = false;
  try {
    process.kill(-pid, signal);
    groupKilled = true;
  } catch {
    groupKilled = false;
  }

  try {
    process.kill(pid, signal);
  } catch {
    if (!groupKilled) {
      return false;
    }
  }
  return true;
}

async function runDown(env, quiet = false) {
  const state = await readPidState(env);
  if (!state) {
    if (!quiet) {
      console.log("[ux] no running stack state found.");
    }
    return;
  }

  const services = [
    ["web", state.webPid],
    ["research", state.researchPid],
    ["orchestrator", state.orchestratorPid],
    ["api", state.apiPid]
  ];

  for (const [name, pid] of services) {
    if (!pid) {
      continue;
    }
    if (!isPidRunning(pid)) {
      if (!quiet) {
        console.log(`[ux] ${name} already stopped (pid ${pid})`);
      }
      continue;
    }

    killPidAndGroup(pid, "SIGTERM");
    await sleep(800);
    if (isPidRunning(pid)) {
      killPidAndGroup(pid, "SIGKILL");
    }

    if (!quiet) {
      console.log(`[ux] stopped ${name} (pid ${pid})`);
    }
  }

  const { pidFile } = statePaths(env);
  await rm(pidFile, { force: true });
  if (!quiet) {
    console.log("[ux] stack stopped");
  }
}

function startDetachedService(name, args, env) {
  const child = spawn("pnpm", args, {
    cwd: rootDir,
    env,
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  if (!child.pid) {
    throw new Error(`Failed to start ${name}`);
  }
  return child.pid;
}

function runMigrations(env) {
  const result = spawnSync(
    "pnpm",
    ["--filter", "@salvo/db", "exec", "tsx", "../../scripts/apply-migrations.ts"],
    {
      cwd: rootDir,
      env,
      stdio: "inherit"
    }
  );

  if (result.status !== 0) {
    throw new Error(`Migration command failed with status ${result.status ?? "unknown"}`);
  }
}

async function waitForApiHealth(env) {
  const apiPort = env.SALVO_API_PORT ?? "8787";
  const healthUrl = `http://localhost:${apiPort}/health`;
  for (let i = 0; i < 45; i += 1) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return true;
      }
    } catch {
      // keep waiting
    }
    await sleep(1000);
  }
  return false;
}

async function runUp(env) {
  const logsDir = path.join(env.SALVO_WORKSPACE_ROOT, "logs");
  await mkdir(logsDir, { recursive: true });

  await runDown(env, true);

  console.log("[ux] applying migrations...");
  runMigrations(env);

  const apiPid = startDetachedService(
    "api",
    ["--filter", "@salvo/orchestrator-api", "start"],
    env
  );
  const orchestratorPid = startDetachedService(
    "orchestrator",
    ["--filter", "@salvo/orchestrator-daemon", "start"],
    env
  );
  const researchPid = startDetachedService(
    "research",
    ["--filter", "@salvo/research-daemon", "start"],
    env
  );
  const webPid = startDetachedService(
    "web",
    ["--filter", "@salvo/web", "dev", "--", "--host", "0.0.0.0", "--port", "5173"],
    env
  );

  await writePidState(env, {
    startedAt: new Date().toISOString(),
    apiPid,
    orchestratorPid,
    researchPid,
    webPid
  });

  const healthy = await waitForApiHealth(env);
  const apiPort = env.SALVO_API_PORT ?? "8787";
  if (!healthy) {
    throw new Error(`API failed health check at http://localhost:${apiPort}/health`);
  }

  console.log("[ux] stack is up");
  console.log("[ux] dashboard: http://localhost:5173");
  console.log(`[ux] api: http://localhost:${apiPort}`);
  console.log(`[ux] health: http://localhost:${apiPort}/health`);
}

async function runStatus(env) {
  const state = await readPidState(env);
  if (!state) {
    console.log("[ux] no running stack state found.");
  } else {
    const services = [
      ["api", state.apiPid],
      ["orchestrator", state.orchestratorPid],
      ["research", state.researchPid],
      ["web", state.webPid]
    ];
    for (const [name, pid] of services) {
      if (!pid) {
        console.log(`[ux] ${name}: not recorded`);
      } else if (isPidRunning(pid)) {
        console.log(`[ux] ${name}: running (pid ${pid})`);
      } else {
        console.log(`[ux] ${name}: not running (stale pid ${pid})`);
      }
    }
  }

  const apiPort = env.SALVO_API_PORT ?? "8787";
  const apiUrl = `http://localhost:${apiPort}`;
  console.log("[ux] control-plane health:");
  try {
    const base = await fetch(`${apiUrl}/health`);
    if (!base.ok) {
      console.log(`[ux] API health returned ${base.status}`);
      return;
    }

    const orchestrator = await fetch(`${apiUrl}/health/orchestrator`);
    const research = await fetch(`${apiUrl}/health/research`);
    console.log(`[ux] /health: ${await base.text()}`);
    console.log(`[ux] /health/orchestrator: ${await orchestrator.text()}`);
    console.log(`[ux] /health/research: ${await research.text()}`);
  } catch {
    console.log(`[ux] API health endpoint unreachable at ${apiUrl}/health`);
  }
}

async function main() {
  const command = process.argv[2] ?? "status";
  const quiet = process.argv.includes("--quiet");
  const env = await runtimeEnv();

  if (command === "up") {
    await runUp(env);
    return;
  }
  if (command === "down") {
    await runDown(env, quiet);
    return;
  }
  if (command === "status") {
    await runStatus(env);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

void main().catch((error) => {
  console.error(`[ux] failed: ${(error).message}`);
  process.exit(1);
});
