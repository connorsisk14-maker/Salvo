import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { loadSecretsIntoEnv } from "../packages/shared/src/secrets.ts";
import { runPreflight } from "./prod-preflight.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFilePath = path.join(rootDir, ".env");
const migrationsDir = path.join(rootDir, "supabase", "migrations");

const localDefaults = {
  dbMode: "docker",
  llmMode: "fake",
  postgresContainer: "salvo-postgres",
  postgresPort: 54329,
  postgresUser: "salvo",
  postgresPassword: "salvo",
  postgresDb: "salvo_test",
  apiPort: 8787,
  fakeLlmHost: "127.0.0.1",
  fakeLlmPort: 9797,
  apiToken: "local-dev-token",
  llmProvider: "anthropic",
  llmApiKey: "fake-key"
};

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

function firstTruthy(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function parseMode(value, fallback, allowed) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function parsePort(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function commandExists(command) {
  const result = spawnSync("which", [command], {
    stdio: "ignore"
  });
  return result.status === 0;
}

async function runtimeEnv() {
  const dotEnv = await loadEnvFromFile();
  const merged = {
    ...process.env,
    ...dotEnv
  };
  await loadSecretsIntoEnv(merged);

  const dbMode = parseMode(merged.SALVO_LOCAL_DB_MODE, localDefaults.dbMode, [
    "docker",
    "external"
  ]);
  const llmMode = parseMode(merged.SALVO_LOCAL_LLM_MODE, localDefaults.llmMode, [
    "fake",
    "real"
  ]);
  const apiPort = parsePort(merged.SALVO_API_PORT, localDefaults.apiPort);
  const postgresPort = parsePort(
    merged.SALVO_LOCAL_POSTGRES_PORT,
    localDefaults.postgresPort
  );
  const fakeLlmPort = parsePort(merged.SALVO_FAKE_LLM_PORT, localDefaults.fakeLlmPort);
  const workspaceRoot =
    merged.SALVO_WORKSPACE_ROOT ?? path.join(rootDir, ".salvo-workspace");
  const postgresContainer =
    firstTruthy(merged.SALVO_LOCAL_POSTGRES_CONTAINER) || localDefaults.postgresContainer;
  const postgresUser = firstTruthy(merged.SALVO_LOCAL_POSTGRES_USER) || localDefaults.postgresUser;
  const postgresPassword =
    firstTruthy(merged.SALVO_LOCAL_POSTGRES_PASSWORD) || localDefaults.postgresPassword;
  const postgresDb = firstTruthy(merged.SALVO_LOCAL_POSTGRES_DB) || localDefaults.postgresDb;
  const synthesizedDbUrl =
    dbMode === "docker"
      ? `postgresql://${postgresUser}:${postgresPassword}@localhost:${postgresPort}/${postgresDb}`
      : "";
  const databaseUrl =
    firstTruthy(merged.SALVO_DATABASE_URL, merged.SALVO_TEST_DATABASE_URL) ||
    synthesizedDbUrl;
  const apiToken =
    firstTruthy(merged.SALVO_API_TOKEN, merged.SALVO_E2E_API_TOKEN) ||
    localDefaults.apiToken;

  const env = {
    ...merged,
    SALVO_LOCAL_DB_MODE: dbMode,
    SALVO_LOCAL_LLM_MODE: llmMode,
    SALVO_LOCAL_POSTGRES_CONTAINER: postgresContainer,
    SALVO_LOCAL_POSTGRES_PORT: String(postgresPort),
    SALVO_LOCAL_POSTGRES_USER: postgresUser,
    SALVO_LOCAL_POSTGRES_PASSWORD: postgresPassword,
    SALVO_LOCAL_POSTGRES_DB: postgresDb,
    SALVO_DATABASE_URL: databaseUrl,
    SALVO_TEST_DATABASE_URL: firstTruthy(merged.SALVO_TEST_DATABASE_URL, databaseUrl),
    SALVO_API_PORT: String(apiPort),
    SALVO_API_TOKEN: apiToken,
    SALVO_E2E_API_URL:
      firstTruthy(merged.SALVO_E2E_API_URL, merged.SALVO_API_URL) ||
      `http://localhost:${apiPort}`,
    SALVO_E2E_API_TOKEN:
      firstTruthy(merged.SALVO_E2E_API_TOKEN, apiToken) || localDefaults.apiToken,
    SALVO_WORKSPACE_ROOT: workspaceRoot,
    VITE_SALVO_API_URL:
      firstTruthy(merged.VITE_SALVO_API_URL) || `http://localhost:${apiPort}`,
    SALVO_HEALTH_ORCHESTRATOR_STALE_SECONDS:
      merged.SALVO_HEALTH_ORCHESTRATOR_STALE_SECONDS ?? "15",
    SALVO_HEALTH_RESEARCH_STALE_SECONDS:
      merged.SALVO_HEALTH_RESEARCH_STALE_SECONDS ?? "45",
    SALVO_FAKE_LLM_HOST:
      firstTruthy(merged.SALVO_FAKE_LLM_HOST) || localDefaults.fakeLlmHost,
    SALVO_FAKE_LLM_PORT: String(fakeLlmPort)
  };

  if (llmMode === "fake") {
    env.SALVO_LLM_PROVIDER =
      firstTruthy(merged.SALVO_LLM_PROVIDER) || localDefaults.llmProvider;
    env.SALVO_LLM_API_KEY =
      firstTruthy(merged.SALVO_LLM_API_KEY, merged.SALVO_CLAUDE_AUTH_TOKEN) ||
      localDefaults.llmApiKey;
    env.SALVO_LLM_BASE_URL =
      firstTruthy(merged.SALVO_LLM_BASE_URL) ||
      `http://${env.SALVO_FAKE_LLM_HOST}:${fakeLlmPort}`;
  }

  return env;
}

function statePaths(env) {
  const stateDir = path.join(env.SALVO_WORKSPACE_ROOT, "dev");
  return {
    stateDir,
    pidFile: path.join(stateDir, "pids.json"),
    logsDir: path.join(env.SALVO_WORKSPACE_ROOT, "logs")
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
  await writeFile(pidFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    ...options
  });
  return result;
}

function runDocker(args, env, allowFailure = false) {
  const result = runCommand("docker", args, {
    env
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error((result.stderr ?? "").trim() || `docker ${args.join(" ")} failed`);
  }
  return result;
}

function dockerInfo(env) {
  return runDocker(["info"], env, true);
}

function isDockerRunning(env) {
  return dockerInfo(env).status === 0;
}

function containerStatus(env, containerName) {
  const result = runDocker(
    ["ps", "-a", "--filter", `name=^/${containerName}$`, "--format", "{{.Status}}"],
    env,
    true
  );
  return (result.stdout ?? "").trim();
}

function isContainerRunning(env, containerName) {
  return containerStatus(env, containerName).toLowerCase().startsWith("up");
}

function ensureContainer(env) {
  const containerName = env.SALVO_LOCAL_POSTGRES_CONTAINER;
  if (!containerStatus(env, containerName)) {
    runDocker(
      [
        "run",
        "-d",
        "--name",
        containerName,
        "-e",
        `POSTGRES_USER=${env.SALVO_LOCAL_POSTGRES_USER}`,
        "-e",
        `POSTGRES_PASSWORD=${env.SALVO_LOCAL_POSTGRES_PASSWORD}`,
        "-e",
        "POSTGRES_DB=postgres",
        "-p",
        `${env.SALVO_LOCAL_POSTGRES_PORT}:5432`,
        "postgres:16-alpine"
      ],
      env
    );
    return;
  }

  if (!isContainerRunning(env, containerName)) {
    runDocker(["start", containerName], env);
  }
}

function execSqlInContainer(env, sql) {
  const result = runDocker(
    [
      "exec",
      env.SALVO_LOCAL_POSTGRES_CONTAINER,
      "psql",
      "-U",
      env.SALVO_LOCAL_POSTGRES_USER,
      "-d",
      "postgres",
      "-tAc",
      sql
    ],
    env,
    true
  );

  if (result.status !== 0) {
    throw new Error((result.stderr ?? "").trim() || "psql command failed inside Docker container.");
  }

  return (result.stdout ?? "").trim();
}

async function waitForContainerDb(env) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 45_000) {
    try {
      execSqlInContainer(env, "select 1");
      return true;
    } catch {
      await sleep(1000);
    }
  }
  return false;
}

function ensureLocalDatabase(env) {
  const dbExists = execSqlInContainer(
    env,
    `select 1 from pg_database where datname = '${env.SALVO_LOCAL_POSTGRES_DB.replace(/'/g, "''")}';`
  );

  if (dbExists !== "1") {
    execSqlInContainer(env, `create database ${env.SALVO_LOCAL_POSTGRES_DB}`);
  }
}

function logFilePath(env, name, stream) {
  return path.join(statePaths(env).logsDir, `${name}.${stream}.log`);
}

function startDetachedProcess(name, command, args, env) {
  const stdoutPath = logFilePath(env, name, "out");
  const stderrPath = logFilePath(env, name, "err");
  mkdirSync(path.dirname(stdoutPath), { recursive: true });
  const stdoutFd = openSync(stdoutPath, "a");
  const stderrFd = openSync(stderrPath, "a");
  const child = spawn(command, args, {
    cwd: rootDir,
    env,
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd]
  });
  child.unref();
  if (!child.pid) {
    throw new Error(`Failed to start ${name}`);
  }
  return child.pid;
}

function servicePidEntries(state) {
  return [
    ["fake-llm", state?.fakeLlmPid],
    ["web", state?.webPid],
    ["research", state?.researchPid],
    ["orchestrator", state?.orchestratorPid],
    ["api", state?.apiPid]
  ];
}

async function runDown(env, quiet = false) {
  const state = await readPidState(env);
  if (!state) {
    if (!quiet) {
      console.log("[ux] no running stack state found.");
    }
    return;
  }

  for (const [name, pid] of servicePidEntries(state)) {
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

function listMigrationFiles() {
  return readdir(migrationsDir).then((files) => files.filter((file) => file.endsWith(".sql")).sort());
}

async function runDoctor(env, options = {}) {
  const report = {
    ok: true,
    mode: "local",
    dbMode: env.SALVO_LOCAL_DB_MODE,
    llmMode: env.SALVO_LOCAL_LLM_MODE,
    apiUrl: env.SALVO_E2E_API_URL,
    databaseUrl: env.SALVO_DATABASE_URL,
    dockerCliPresent: commandExists("docker"),
    dockerRunning: false,
    postgresContainerRunning: false,
    databaseReachable: false,
    migrationFileCount: 0,
    fakeLlmConfigured: env.SALVO_LOCAL_LLM_MODE === "fake",
    apiTokenPresent: Boolean(env.SALVO_API_TOKEN),
    apiTokenSource:
      firstTruthy(process.env.SALVO_API_TOKEN, process.env.SALVO_E2E_API_TOKEN) ? "env" : "synthesized",
    warnings: [],
    errors: []
  };

  const migrationFiles = await listMigrationFiles();
  report.migrationFileCount = migrationFiles.length;
  if (migrationFiles.length === 0) {
    report.errors.push("No SQL migration files found in supabase/migrations.");
  }

  const preflightEnv = {
    ...process.env,
    ...env
  };
  const priorEnv = {};
  for (const [key, value] of Object.entries(preflightEnv)) {
    priorEnv[key] = process.env[key];
    process.env[key] = value;
  }

  try {
    const preflight = await runPreflight({
      mode: "local",
      strictLlm: env.SALVO_LOCAL_LLM_MODE === "real",
      skipDb: true
    });
    report.warnings.push(...preflight.warnings);
    report.errors.push(...preflight.errors);
  } finally {
    for (const [key, value] of Object.entries(priorEnv)) {
      if (typeof value === "string") {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  }

  if (env.SALVO_LOCAL_DB_MODE === "docker") {
    if (!report.dockerCliPresent) {
      report.errors.push("Docker CLI is not available in PATH.");
    } else {
      report.dockerRunning = isDockerRunning(env);
      if (!report.dockerRunning) {
        report.errors.push("Docker is not running. Start Docker Desktop before using ux commands.");
      } else {
        report.postgresContainerRunning = isContainerRunning(env, env.SALVO_LOCAL_POSTGRES_CONTAINER);
        if (report.postgresContainerRunning) {
          try {
            execSqlInContainer(env, "select 1");
            report.databaseReachable = true;
          } catch {
            report.warnings.push("Local Postgres container exists but is not yet reachable.");
          }
        } else {
          report.warnings.push("Local Postgres container is not running. `pnpm ux:db:up` will provision it.");
        }
      }
    }
  } else if (!env.SALVO_DATABASE_URL) {
    report.errors.push("SALVO_DATABASE_URL (or SALVO_TEST_DATABASE_URL) is required in external DB mode.");
  }

  if (env.SALVO_LOCAL_LLM_MODE === "fake") {
    if (!env.SALVO_LLM_BASE_URL) {
      report.errors.push("Fake LLM mode did not resolve SALVO_LLM_BASE_URL.");
    }
  } else if (!firstTruthy(env.SALVO_LLM_API_KEY, env.SALVO_CLAUDE_AUTH_TOKEN)) {
    report.errors.push("Real LLM mode requires SALVO_LLM_API_KEY or SALVO_CLAUDE_AUTH_TOKEN.");
  }

  report.ok = report.errors.length === 0;

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[ux] doctor: ${report.ok ? "PASS" : "FAIL"}`);
    console.log(`[ux] local db mode: ${report.dbMode}`);
    console.log(`[ux] local llm mode: ${report.llmMode}`);
    console.log(`[ux] api token source: ${report.apiTokenSource}`);
    console.log(`[ux] migration files: ${report.migrationFileCount}`);
    if (report.dbMode === "docker") {
      console.log(`[ux] docker cli present: ${report.dockerCliPresent ? "yes" : "no"}`);
      console.log(`[ux] docker running: ${report.dockerRunning ? "yes" : "no"}`);
      console.log(`[ux] postgres container running: ${report.postgresContainerRunning ? "yes" : "no"}`);
      console.log(`[ux] database reachable: ${report.databaseReachable ? "yes" : "no"}`);
    }
    for (const warning of report.warnings) {
      console.log(`[ux] WARN: ${warning}`);
    }
    for (const error of report.errors) {
      console.log(`[ux] ERROR: ${error}`);
    }
  }

  if (!report.ok) {
    throw new Error("Local preflight failed.");
  }
}

async function runDbUp(env) {
  if (env.SALVO_LOCAL_DB_MODE !== "docker") {
    if (!env.SALVO_DATABASE_URL) {
      throw new Error("External DB mode requires SALVO_DATABASE_URL.");
    }
    console.log("[ux] external DB mode selected; skipping local Docker Postgres bootstrap.");
    return;
  }

  if (!commandExists("docker")) {
    throw new Error("Docker CLI is not available in PATH.");
  }
  if (!isDockerRunning(env)) {
    throw new Error("Docker is not running. Start Docker Desktop before bootstrapping the local database.");
  }

  ensureContainer(env);
  const ready = await waitForContainerDb(env);
  if (!ready) {
    throw new Error("Local Postgres container did not become ready in time.");
  }

  ensureLocalDatabase(env);
  console.log(
    `[ux] local Postgres ready at localhost:${env.SALVO_LOCAL_POSTGRES_PORT}/${env.SALVO_LOCAL_POSTGRES_DB}`
  );
}

async function runLlmUp(env, persist = true) {
  if (env.SALVO_LOCAL_LLM_MODE !== "fake") {
    console.log("[ux] real LLM mode selected; skipping fake LLM bootstrap.");
    return null;
  }

  const state = await readPidState(env);
  if (state?.fakeLlmPid && isPidRunning(state.fakeLlmPid)) {
    console.log(`[ux] fake LLM already running (pid ${state.fakeLlmPid})`);
    return state.fakeLlmPid;
  }

  const fakeLlmPid = startDetachedProcess(
    "fake-llm",
    "node",
    [path.join(rootDir, "scripts", "fake-llm-server.mjs")],
    env
  );

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${env.SALVO_LLM_BASE_URL}/health`);
      if (response.ok) {
        if (persist) {
          const nextState = {
            ...(state ?? {}),
            fakeLlmPid
          };
          await writePidState(env, nextState);
        }
        console.log(`[ux] fake LLM ready at ${env.SALVO_LLM_BASE_URL}`);
        return fakeLlmPid;
      }
    } catch {
      // keep waiting
    }
    await sleep(500);
  }

  throw new Error(`Fake LLM failed health check at ${env.SALVO_LLM_BASE_URL}/health`);
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
  const healthUrl = `${env.SALVO_E2E_API_URL}/health`;
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

function buildAuthHeaders(env) {
  return env.SALVO_API_TOKEN ? { authorization: `Bearer ${env.SALVO_API_TOKEN}` } : {};
}

async function fetchText(url, init) {
  const response = await fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    body: await response.text()
  };
}

async function runUp(env) {
  const { logsDir } = statePaths(env);
  await mkdir(logsDir, { recursive: true });

  await runDoctor(env);
  await runDbUp(env);
  await runDown(env, true);
  const fakeLlmPid = await runLlmUp(env, false);

  console.log("[ux] applying migrations...");
  runMigrations(env);

  const apiPid = startDetachedProcess(
    "api",
    "pnpm",
    ["--filter", "@salvo/orchestrator-api", "start"],
    env
  );
  const orchestratorPid = startDetachedProcess(
    "orchestrator",
    "pnpm",
    ["--filter", "@salvo/orchestrator-daemon", "start"],
    env
  );
  const researchPid = startDetachedProcess(
    "research",
    "pnpm",
    ["--filter", "@salvo/research-daemon", "start"],
    env
  );
  const webPid = startDetachedProcess(
    "web",
    "pnpm",
    ["--filter", "@salvo/web", "dev", "--", "--host", "0.0.0.0", "--port", "5173"],
    env
  );

  await writePidState(env, {
    startedAt: new Date().toISOString(),
    fakeLlmPid,
    apiPid,
    orchestratorPid,
    researchPid,
    webPid
  });

  const healthy = await waitForApiHealth(env);
  if (!healthy) {
    throw new Error(`API failed health check at ${env.SALVO_E2E_API_URL}/health`);
  }

  console.log("[ux] stack is up");
  console.log("[ux] dashboard: http://localhost:5173");
  console.log(`[ux] api: ${env.SALVO_E2E_API_URL}`);
  console.log(`[ux] health: ${env.SALVO_E2E_API_URL}/health`);
}

async function runStatus(env) {
  const state = await readPidState(env);
  if (!state) {
    console.log("[ux] no running stack state found.");
  } else {
    for (const [name, pid] of servicePidEntries(state)) {
      if (!pid) {
        continue;
      }
      if (isPidRunning(pid)) {
        console.log(`[ux] ${name}: running (pid ${pid})`);
      } else {
        console.log(`[ux] ${name}: not running (stale pid ${pid})`);
      }
    }
  }

  console.log("[ux] control-plane health:");
  try {
    const base = await fetchText(`${env.SALVO_E2E_API_URL}/health`);
    console.log(`[ux] /health (${base.status}): ${base.body}`);
    if (!base.ok) {
      return;
    }

    if (!env.SALVO_API_TOKEN) {
      console.log("[ux] /health/orchestrator: auth required");
      console.log("[ux] /health/research: auth required");
      return;
    }

    const authHeaders = buildAuthHeaders(env);
    const orchestrator = await fetchText(`${env.SALVO_E2E_API_URL}/health/orchestrator`, {
      headers: authHeaders
    });
    const research = await fetchText(`${env.SALVO_E2E_API_URL}/health/research`, {
      headers: authHeaders
    });

    console.log(`[ux] /health/orchestrator (${orchestrator.status}): ${orchestrator.body}`);
    console.log(`[ux] /health/research (${research.status}): ${research.body}`);
  } catch {
    console.log(`[ux] API health endpoint unreachable at ${env.SALVO_E2E_API_URL}/health`);
  }
}

function runSmoke(env) {
  const result = spawnSync("node", [path.join(rootDir, "scripts", "e2e-smoke.mjs")], {
    cwd: rootDir,
    env,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    throw new Error(`Smoke command failed with status ${result.status ?? "unknown"}`);
  }
}

async function runClean(env) {
  const workspaceRoot = env.SALVO_WORKSPACE_ROOT;
  const targets = [
    path.join(workspaceRoot, "dev"),
    path.join(workspaceRoot, "logs"),
    path.join(workspaceRoot, "runs"),
    path.join(workspaceRoot, "backups", "status.json")
  ];

  for (const target of targets) {
    await rm(target, {
      recursive: true,
      force: true
    });
  }

  const backupsDir = path.join(workspaceRoot, "backups");
  try {
    const remaining = await readdir(backupsDir);
    if (remaining.length === 0) {
      await rm(backupsDir, {
        recursive: true,
        force: true
      });
    }
  } catch {
    // ignore
  }

  console.log(`[ux] cleaned local runtime artifacts under ${workspaceRoot}`);
}

async function main() {
  const command = process.argv[2] ?? "status";
  const quiet = process.argv.includes("--quiet");
  const json = process.argv.includes("--json");
  const env = await runtimeEnv();

  if (command === "doctor") {
    await runDoctor(env, { json });
    return;
  }
  if (command === "db:up") {
    await runDbUp(env);
    return;
  }
  if (command === "llm:up") {
    await runLlmUp(env);
    return;
  }
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
  if (command === "smoke") {
    runSmoke(env);
    return;
  }
  if (command === "clean") {
    await runClean(env);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

void main().catch((error) => {
  console.error(`[ux] failed: ${error.message}`);
  process.exit(1);
});
