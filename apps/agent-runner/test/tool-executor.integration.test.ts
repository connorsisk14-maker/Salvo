import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import { buildToolPolicy, CommandAdapter, FilesystemAdapter } from "@salvo/tools";
import { createDbPool, SalvoRepository } from "@salvo/db";
import { executeToolUse } from "@salvo/llm";

const databaseUrl = process.env.SALVO_TEST_DATABASE_URL ?? process.env.SALVO_DATABASE_URL;

if (!databaseUrl) {
  test("tool executor integration skipped (no SALVO_TEST_DATABASE_URL or SALVO_DATABASE_URL)", { skip: true }, () => {});
} else {
  const pool = createDbPool(databaseUrl);
  const repo = new SalvoRepository(pool);
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

  async function runMigrations(): Promise<void> {
    const migrationDir = path.resolve(rootDir, "supabase/migrations");
    for (const fileName of [
      "0001_bootstrap.sql",
      "0002_runtime_contract.sql",
      "0003_daemon_heartbeats.sql",
      "0004_run_cancellation.sql",
      "0005_integration_configs.sql",
      "0006_llm_api_integration_cutover.sql",
      "0007_research_analysis_pipeline.sql",
      "0008_idempotency_recovery.sql",
      "0009_budget_caps.sql",
      "0010_agent_trust_tiers.sql"
    ]) {
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

  async function createBasicRun() {
    const workspace = await repo.ensureWorkspace(`ws-${randomUUID()}`, process.cwd());
    const task = await repo.createTask({
      workspaceId: workspace.id,
      title: "claim task",
      request: "do something",
      requiresApproval: false
    });
    const contract = await repo.createContract({
      taskId: task.id,
      risk: "low",
      status: "active",
      contractJson: {
        schema_version: 1
      }
    });
    const run = await repo.createRun({
      taskId: task.id,
      contractId: contract.id,
      agentProfile: "builder",
      workerId: "worker-a"
    });

    return { task, run };
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

  test("write_file persists run events and artifact rows through the executor", async () => {
    const { task, run } = await createBasicRun();
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "salvo-tool-executor-"));
    const policy = buildToolPolicy(workspaceRoot, {
      allowedReadPaths: ["."],
      allowedWritePaths: ["."],
      forbiddenPaths: [],
      allowedCommandCwds: ["."],
      allowedCommands: ["echo"],
      commandTimeoutMs: 5_000
    });
    const filesystem = new FilesystemAdapter(workspaceRoot, policy);
    const command = new CommandAdapter(policy);

    const outcome = await executeToolUse({
      block: {
        type: "tool_use",
        id: "write-1",
        name: "write_file",
        input: {
          path: "run-summary.md",
          content: "# hello"
        }
      },
      workspaceRoot,
      deps: {
        readFile: (targetPath) => filesystem.readFile(targetPath),
        writeFile: (targetPath, content) => filesystem.writeFile(targetPath, content),
        listDirectory: (targetPath) => filesystem.listDirectory(targetPath),
        runCommand: (cmd, args, cwd, timeoutMs) => command.run(cmd, args, cwd, timeoutMs)
      },
      persistence: {
        appendRunEvent: (eventType, level, payload) => repo.appendRunEvent(run.id, eventType, level, payload).then(() => undefined),
        createArtifact: (params) =>
          repo.createArtifact({
            runId: run.id,
            taskId: task.id,
            artifactType: params.artifactType,
            path: params.path,
            metadataJson: params.metadataJson
          })
      }
    });

    assert.equal(outcome.policyDenied, false);

    const events = await repo.listRunEvents(run.id);
    const artifacts = await repo.listArtifactsForRun(run.id);

    assert.deepEqual(
      events.map((event) => event.event_type),
      ["tool.called", "artifact.created", "tool.result"]
    );
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.artifact_type, "markdown");
    assert.equal(artifacts[0]?.metadata_json.label, "run-summary.md");
  });

  test("run_command persists tool results and required test evidence", async () => {
    const { task, run } = await createBasicRun();
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "salvo-tool-executor-"));
    const policy = buildToolPolicy(workspaceRoot, {
      allowedReadPaths: ["."],
      allowedWritePaths: ["."],
      forbiddenPaths: [],
      allowedCommandCwds: ["."],
      allowedCommands: ["echo"],
      commandTimeoutMs: 5_000
    });
    const filesystem = new FilesystemAdapter(workspaceRoot, policy);
    const command = new CommandAdapter(policy);

    const outcome = await executeToolUse({
      block: {
        type: "tool_use",
        id: "cmd-1",
        name: "run_command",
        input: {
          command: "echo",
          args: ["salvo-test"]
        }
      },
      workspaceRoot,
      requiredTestCommands: new Set(["echo salvo-test"]),
      deps: {
        readFile: (targetPath) => filesystem.readFile(targetPath),
        writeFile: (targetPath, content) => filesystem.writeFile(targetPath, content),
        listDirectory: (targetPath) => filesystem.listDirectory(targetPath),
        runCommand: (cmd, args, cwd, timeoutMs) => command.run(cmd, args, cwd, timeoutMs)
      },
      persistence: {
        appendRunEvent: (eventType, level, payload) => repo.appendRunEvent(run.id, eventType, level, payload).then(() => undefined),
        createArtifact: (params) =>
          repo.createArtifact({
            runId: run.id,
            taskId: task.id,
            artifactType: params.artifactType,
            path: params.path,
            metadataJson: params.metadataJson
          })
      }
    });

    assert.equal(outcome.policyDenied, false);
    assert.deepEqual(outcome.requiredTestCommandResult, {
      command: "echo salvo-test",
      evidence: {
        command: "echo salvo-test",
        exit_code: 0,
        stdout: "salvo-test",
        stderr: "",
        duration_ms: outcome.requiredTestCommandResult?.evidence.duration_ms
      }
    });

    const events = await repo.listRunEvents(run.id);
    assert.deepEqual(
      events.map((event) => event.event_type),
      ["tool.called", "tool.result"]
    );
  });

  test("run_command deny persists policy.denied without artifacts", async () => {
    const { task, run } = await createBasicRun();
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "salvo-tool-executor-"));
    const policy = buildToolPolicy(workspaceRoot, {
      allowedReadPaths: ["."],
      allowedWritePaths: ["."],
      forbiddenPaths: [],
      allowedCommandCwds: ["."],
      allowedCommands: ["echo"],
      commandTimeoutMs: 5_000
    });
    const filesystem = new FilesystemAdapter(workspaceRoot, policy);
    const command = new CommandAdapter(policy);

    const outcome = await executeToolUse({
      block: {
        type: "tool_use",
        id: "cmd-2",
        name: "run_command",
        input: {
          command: "pnpm",
          args: ["test"]
        }
      },
      workspaceRoot,
      requiredTestCommands: new Set(["pnpm test"]),
      deps: {
        readFile: (targetPath) => filesystem.readFile(targetPath),
        writeFile: (targetPath, content) => filesystem.writeFile(targetPath, content),
        listDirectory: (targetPath) => filesystem.listDirectory(targetPath),
        runCommand: (cmd, args, cwd, timeoutMs) => command.run(cmd, args, cwd, timeoutMs)
      },
      persistence: {
        appendRunEvent: (eventType, level, payload) => repo.appendRunEvent(run.id, eventType, level, payload).then(() => undefined),
        createArtifact: (params) =>
          repo.createArtifact({
            runId: run.id,
            taskId: task.id,
            artifactType: params.artifactType,
            path: params.path,
            metadataJson: params.metadataJson
          })
      }
    });

    assert.equal(outcome.policyDenied, true);

    const events = await repo.listRunEvents(run.id);
    assert.deepEqual(
      events.map((event) => event.event_type),
      ["tool.called", "policy.denied"]
    );
    const artifacts = await repo.listArtifactsForRun(run.id);
    assert.equal(artifacts.length, 0);
  });
}
