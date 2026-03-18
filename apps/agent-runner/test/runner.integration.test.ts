import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDbPool, SalvoRepository } from "@salvo/db";

const databaseUrl = process.env.SALVO_TEST_DATABASE_URL ?? process.env.SALVO_DATABASE_URL;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnCommand(command: string, args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): ChildProcess {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}

    await sleep(250);
  }

  throw new Error(`Timed out waiting for server: ${url}`);
}

async function waitForRunCompletion(
  repo: SalvoRepository,
  taskId: string,
  timeoutMs: number
): Promise<{
  runId: string;
  detail: Awaited<ReturnType<SalvoRepository["getRunDetail"]>>;
  finalPayload: Record<string, unknown> | null;
  events: Awaited<ReturnType<SalvoRepository["listRunEvents"]>>;
  artifacts: Awaited<ReturnType<SalvoRepository["listArtifactsForRun"]>>;
}> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const run = (await repo.listRuns(20)).find((entry) => entry.task_id === taskId);
    if (!run) {
      await sleep(250);
      continue;
    }

    const detail = await repo.getRunDetail(run.id);
    if (!detail || !detail.evaluation) {
      await sleep(500);
      continue;
    }

    const [finalPayload, events, artifacts] = await Promise.all([
      repo.getRunFinalPayload(run.id),
      repo.listRunEvents(run.id),
      repo.listArtifactsForRun(run.id)
    ]);

    return {
      runId: run.id,
      detail,
      finalPayload,
      events,
      artifacts
    };
  }

  throw new Error(`Timed out waiting for evaluated run for task ${taskId}`);
}

if (!databaseUrl) {
  test("runner integration skipped (no SALVO_TEST_DATABASE_URL or SALVO_DATABASE_URL)", { skip: true }, () => {});
} else {
  const pool = createDbPool(databaseUrl);
  const repo = new SalvoRepository(pool);
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

  async function runMigrations(): Promise<void> {
    const migrationDir = path.resolve(rootDir, "supabase/migrations");
    const files = (await readdir(migrationDir)).filter((name) => name.endsWith(".sql"));
    for (const fileName of files.sort()) {
      const sql = await readFile(path.join(migrationDir, fileName), "utf8");
      await pool.query(sql);
    }
  }

  async function resetTables(): Promise<void> {
    await pool.query(`
      truncate table
        public.salvo_memories,
        public.salvo_research_findings,
        public.salvo_research_experiments,
        public.salvo_research_ingestions,
        public.salvo_research_documents,
        public.salvo_evaluations,
        public.salvo_artifacts,
        public.salvo_run_events,
        public.salvo_runs,
        public.salvo_contracts,
        public.salvo_tasks,
        public.salvo_idempotency_keys,
        public.salvo_budget_limits,
        public.salvo_agent_trust_tiers,
        public.salvo_integration_configs,
        public.salvo_daemon_heartbeats,
        public.salvo_workspaces
      restart identity cascade
    `);
  }

  before(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await resetTables();
  });

  after(async () => {
    await repo.close();
  });

  test("orchestrator + runner complete a deterministic fake-LLM round-trip with evaluation", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "salvo-runner-int-"));
    const fakeLlmPort = String(9900 + Math.floor(Math.random() * 200));
    const env = {
      ...process.env,
      SALVO_DATABASE_URL: databaseUrl,
      SALVO_TEST_DATABASE_URL: databaseUrl,
      SALVO_WORKSPACE_ROOT: workspaceRoot,
      SALVO_LLM_PROVIDER: "anthropic",
      SALVO_LLM_API_KEY: "test-key",
      SALVO_LLM_BASE_URL: `http://127.0.0.1:${fakeLlmPort}`
    };

    const fakeLlm = spawnCommand("node", ["scripts/fake-llm-server.mjs"], {
      cwd: rootDir,
      env: {
        ...env,
        SALVO_FAKE_LLM_PORT: fakeLlmPort
      }
    });

    try {
      await waitForServer(`http://127.0.0.1:${fakeLlmPort}/health`, 10_000);
      const daemon = spawnCommand("pnpm", ["--filter", "@salvo/orchestrator-daemon", "start"], {
        cwd: rootDir,
        env
      });

      try {
        const workspace = await repo.ensureWorkspace("default", workspaceRoot);
        const task = await repo.createTask({
          workspaceId: workspace.id,
          title: "runner integration smoke",
          request: "Create a sample run summary artifact for integration smoke test.",
          requiresApproval: false
        });

        const result = await waitForRunCompletion(repo, task.id, 45_000);
        assert.equal(result.detail?.evaluation?.passed, true);
        assert.equal(result.detail?.run.status, "completed");
        assert.ok(result.finalPayload);
        assert.equal(Array.isArray(result.finalPayload?.deliverables), true);
        assert.equal(result.artifacts.length > 0, true);
        assert.equal(
          result.events.some((event) => event.event_type === "tool.called"),
          true
        );
        assert.equal(
          result.events.some((event) => event.event_type === "tool.result"),
          true
        );
        assert.equal(
          result.events.some((event) => event.event_type === "evaluation.completed"),
          true
        );
      } finally {
        daemon.kill("SIGTERM");
        await new Promise((resolve) => daemon.once("exit", resolve));
      }
    } finally {
      fakeLlm.kill("SIGTERM");
      await new Promise((resolve) => fakeLlm.once("exit", resolve));
    }
  });
}
