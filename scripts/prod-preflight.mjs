import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadSecretsIntoEnv } from "../packages/shared/src/secrets.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFilePath = path.join(rootDir, ".env");
const migrationsDir = path.join(rootDir, "supabase", "migrations");

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

function commandExists(command) {
  const result = spawnSync("which", [command], {
    stdio: "ignore"
  });
  return result.status === 0;
}

function firstTruthy(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

export async function buildRuntimeEnv() {
  const dotEnv = await loadEnvFromFile();
  const merged = {
    ...process.env,
    ...dotEnv
  };
  await loadSecretsIntoEnv(merged);
  const workspaceRoot = firstTruthy(
    merged.SALVO_WORKSPACE_ROOT,
    path.join(rootDir, ".salvo-workspace")
  );

  return {
    ...merged,
    SALVO_WORKSPACE_ROOT: workspaceRoot
  };
}

async function listMigrationFiles() {
  const files = await readdir(migrationsDir);
  return files
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();
}

async function checkDatabase(databaseUrl) {
  const checks = {
    connected: false,
    requiredTablesPresent: false,
    integrationsTablePresent: false,
    missingTables: [],
    integrationKeys: [],
    llmConfigured: false,
    llmConfigurationSource: "none"
  };
  const requiredTables = [
    "public.salvo_workspaces",
    "public.salvo_tasks",
    "public.salvo_contracts",
    "public.salvo_runs",
    "public.salvo_daemon_heartbeats",
    "public.salvo_integration_configs",
    "public.audit_events"
  ];

  const runPsql = (sql) => {
    const result = spawnSync(
      "psql",
      [databaseUrl, "-v", "ON_ERROR_STOP=1", "-Atq", "-F", "|", "-c", sql],
      {
        encoding: "utf8"
      }
    );
    if (result.status !== 0) {
      const stderr = (result.stderr ?? "").trim();
      throw new Error(stderr || `psql exited with ${result.status}`);
    }
    return (result.stdout ?? "").trim();
  };

  runPsql("select 1");
  checks.connected = true;

  const tableRows = runPsql(
    `select table_name, case when to_regclass(table_name) is null then 0 else 1 end
     from unnest(array[${requiredTables.map((name) => `'${name}'`).join(",")}]) as table_name`
  )
    .split("\n")
    .filter(Boolean);
  checks.missingTables = tableRows
    .map((line) => {
      const [tableName, present] = line.split("|");
      return {
        tableName,
        present: present === "1"
      };
    })
    .filter((row) => !row.present)
    .map((row) => row.tableName);
    checks.requiredTablesPresent = checks.missingTables.length === 0;
  checks.integrationsTablePresent = !checks.missingTables.includes("public.salvo_integration_configs");

  if (checks.integrationsTablePresent) {
    const integrationJson = runPsql(
      `select coalesce(
          json_agg(
            json_build_object(
              'integration_key', integration_key,
              'config_json', config_json
            )
            order by integration_key asc
          )::text,
          '[]'
        )
       from public.salvo_integration_configs`
    );
    const integrations = JSON.parse(integrationJson);
    checks.integrationKeys = integrations.map((row) => row.integration_key);
    const llmRow = integrations.find((row) => row.integration_key === "llm_api");
    const llmConfig = llmRow?.config_json ?? {};
    const llmApiKey = firstTruthy(llmConfig.apiKey, llmConfig.authToken);
    if (llmApiKey) {
      checks.llmConfigured = true;
      checks.llmConfigurationSource = "integration:llm_api";
    }
  }

  return checks;
}

export async function runPreflight(options = {}) {
  const opts = {
    strictLlm: false,
    skipDb: false,
    mode: "production",
    ...options
  };
  const isLocalMode = opts.mode === "local";
  const env = await buildRuntimeEnv();
  const errors = [];
  const warnings = [];
  const checks = {
    platformDarwin: process.platform === "darwin",
    launchctl: commandExists("launchctl"),
    pnpm: commandExists("pnpm"),
    psql: commandExists("psql"),
    envFileFound: false,
    databaseUrlPresent: Boolean(firstTruthy(env.SALVO_DATABASE_URL, env.SALVO_TEST_DATABASE_URL)),
    apiTokenPresent: Boolean(firstTruthy(env.SALVO_API_TOKEN)),
    workspaceRoot: env.SALVO_WORKSPACE_ROOT,
    mode: opts.mode,
    migrationFileCount: 0,
    database: null
  };

  try {
    await access(envFilePath);
    checks.envFileFound = true;
  } catch {
    warnings.push("No .env file found at repository root. Runtime relies on shell or secrets backend.");
  }

  if (!checks.platformDarwin) {
    const message = "Production launchd deployment requires macOS (darwin).";
    if (isLocalMode) {
      warnings.push(message);
    } else {
      errors.push(message);
    }
  }
  if (!checks.launchctl) {
    const message = "launchctl is not available in PATH.";
    if (isLocalMode) {
      warnings.push(message);
    } else {
      errors.push(message);
    }
  }
  if (!checks.pnpm) {
    errors.push("pnpm is not available in PATH.");
  }
  if (!checks.psql && !opts.skipDb) {
    errors.push("psql is not available in PATH (required for database preflight checks).");
  }
  if (!checks.databaseUrlPresent) {
    errors.push("SALVO_DATABASE_URL (or SALVO_TEST_DATABASE_URL) is not configured.");
  }
  if (!checks.apiTokenPresent) {
    errors.push("SALVO_API_TOKEN is not configured (required for authenticated control operations).");
  }

  const migrationFiles = await listMigrationFiles();
  checks.migrationFileCount = migrationFiles.length;
  if (migrationFiles.length === 0) {
    errors.push("No SQL migration files found in supabase/migrations.");
  }

  const databaseUrl = firstTruthy(env.SALVO_DATABASE_URL, env.SALVO_TEST_DATABASE_URL);
  if (!opts.skipDb && databaseUrl && checks.psql) {
    try {
      checks.database = await checkDatabase(databaseUrl);
      if (!checks.database.connected) {
        errors.push("Database connectivity check failed.");
      }
      if (!checks.database.requiredTablesPresent) {
        errors.push(
          `Database schema missing required tables: ${checks.database.missingTables.join(", ")}`
        );
      }
      if (!checks.database.llmConfigured) {
        const envFallback = firstTruthy(env.SALVO_LLM_API_KEY, env.SALVO_CLAUDE_AUTH_TOKEN);
        if (envFallback) {
          checks.database.llmConfigured = true;
          checks.database.llmConfigurationSource = "env";
        }
      }
      if (!checks.database.llmConfigured) {
        const message =
          "No LLM credential found in llm_api integration config or SALVO_LLM_API_KEY/SALVO_CLAUDE_AUTH_TOKEN.";
        if (opts.strictLlm) {
          errors.push(message);
        } else {
          warnings.push(message);
        }
      }
      const recommendedIntegrations = ["llm_api", "process", "http"];
      for (const key of recommendedIntegrations) {
        if (!checks.database.integrationKeys.includes(key)) {
          warnings.push(`Integration config '${key}' is missing in salvo_integration_configs.`);
        }
      }
    } catch (error) {
      errors.push(`Database verification failed: ${error.message}`);
    }
  } else if (opts.skipDb) {
    warnings.push("Database verification was skipped (--skip-db).");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checks
  };
}

function printReport(report) {
  const status = report.ok ? "PASS" : "FAIL";
  console.log(`[prod-preflight] ${status}`);
  console.log(`[prod-preflight] mode: ${report.checks.mode}`);
  console.log(`[prod-preflight] platform darwin: ${report.checks.platformDarwin ? "yes" : "no"}`);
  console.log(`[prod-preflight] launchctl present: ${report.checks.launchctl ? "yes" : "no"}`);
  console.log(`[prod-preflight] pnpm present: ${report.checks.pnpm ? "yes" : "no"}`);
  console.log(`[prod-preflight] psql present: ${report.checks.psql ? "yes" : "no"}`);
  console.log(`[prod-preflight] .env found: ${report.checks.envFileFound ? "yes" : "no"}`);
  console.log(`[prod-preflight] migration files: ${report.checks.migrationFileCount}`);
  console.log(`[prod-preflight] database url present: ${report.checks.databaseUrlPresent ? "yes" : "no"}`);
  console.log(`[prod-preflight] api token present: ${report.checks.apiTokenPresent ? "yes" : "no"}`);

  if (report.checks.database) {
    console.log(`[prod-preflight] db connected: ${report.checks.database.connected ? "yes" : "no"}`);
    console.log(
      `[prod-preflight] required tables present: ${report.checks.database.requiredTablesPresent ? "yes" : "no"}`
    );
    console.log(
      `[prod-preflight] llm configured: ${report.checks.database.llmConfigured ? "yes" : "no"} (${report.checks.database.llmConfigurationSource})`
    );
    if (report.checks.database.integrationKeys.length > 0) {
      console.log(
        `[prod-preflight] integration keys: ${report.checks.database.integrationKeys.join(", ")}`
      );
    }
  }

  for (const warning of report.warnings) {
    console.log(`[prod-preflight] WARN: ${warning}`);
  }
  for (const error of report.errors) {
    console.log(`[prod-preflight] ERROR: ${error}`);
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const report = await runPreflight({
    strictLlm: args.has("--strict-llm"),
    skipDb: args.has("--skip-db"),
    mode: args.has("--local") ? "local" : "production"
  });

  if (args.has("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (!report.ok) {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(`[prod-preflight] FAIL: ${error.message}`);
    process.exit(1);
  });
}
