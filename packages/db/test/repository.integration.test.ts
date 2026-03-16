import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { SalvoRepository } from "../src/repository";

const databaseUrl = process.env.SALVO_TEST_DATABASE_URL ?? process.env.SALVO_DATABASE_URL;

if (!databaseUrl) {
  test("db integration tests skipped (no SALVO_TEST_DATABASE_URL or SALVO_DATABASE_URL)", { skip: true }, () => {});
} else {
  const pool = new Pool({ connectionString: databaseUrl });
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
      "0008_idempotency_recovery.sql"
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

    return {
      workspace,
      task,
      contract,
      run
    };
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

  test("claim semantics: two workers cannot claim the same queued task", async () => {
    const workspace = await repo.ensureWorkspace(`claim-${randomUUID()}`, process.cwd());
    const task = await repo.createTask({
      workspaceId: workspace.id,
      title: "only once",
      request: "claim me",
      requiresApproval: false
    });

    const [workerA, workerB] = await Promise.all([
      repo.claimNextTask("worker-a"),
      repo.claimNextTask("worker-b")
    ]);

    const claimed = [workerA, workerB].filter(Boolean);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.id, task.id);
  });

  test("run_events table is append-only (update/delete blocked)", async () => {
    const { run } = await createBasicRun();
    const event = await repo.appendRunEvent(run.id, "run.started", "info", {
      note: "hello"
    });

    await assert.rejects(async () => {
      await pool.query(
        `update public.salvo_run_events set level = 'error' where id = $1`,
        [event.id]
      );
    });

    await assert.rejects(async () => {
      await pool.query(`delete from public.salvo_run_events where id = $1`, [event.id]);
    });
  });

  test("stale runner detection schedules retry as new run", async () => {
    const { run, task } = await createBasicRun();

    await repo.transitionRunStatus(run.id, "starting", {
      workerId: "worker-a"
    });
    await repo.transitionRunStatus(run.id, "running", {
      startedAt: new Date(Date.now() - 35_000),
      heartbeatAt: new Date(Date.now() - 35_000)
    });
    await repo.transitionTaskStatus(task.id, "planning");
    await repo.transitionTaskStatus(task.id, "running");

    const staleRuns = await repo.findStaleRuns(30);
    assert.equal(staleRuns.length, 1);
    assert.equal(staleRuns[0].id, run.id);

    const retry = await repo.scheduleRetryFromStaleRun(run.id, "worker-b", 2);
    assert.equal(retry.disposition, "scheduled");
    assert.ok(retry.retryRun);
    assert.equal(retry.retryRun?.attempt_no, 2);

    const staleRun = await repo.getRun(run.id);
    assert.equal(staleRun?.status, "failed");
    assert.equal(staleRun?.exit_reason, "stale_runner");
  });

  test("manual retry request re-queues failed task and appends retry event", async () => {
    const { run, task } = await createBasicRun();

    await repo.transitionRunStatus(run.id, "starting");
    await repo.transitionRunStatus(run.id, "running");
    await repo.transitionRunStatus(run.id, "failed");
    await repo.transitionTaskStatus(task.id, "planning");
    await repo.transitionTaskStatus(task.id, "running");
    await repo.transitionTaskStatus(task.id, "failed");

    const retry = await repo.requestRetryForRun(run.id);
    assert.equal(retry.task.status, "queued");

    const events = await repo.listRunEvents(run.id);
    assert.equal(events.some((event) => event.event_type === "run.retry_requested"), true);
  });

  test("idempotent task creation replays the original task row", async () => {
    const workspace = await repo.ensureWorkspace(`idem-${randomUUID()}`, process.cwd());
    const first = await repo.createTaskIdempotent(
      {
        workspaceId: workspace.id,
        title: "same task",
        request: "do the same thing",
        requiresApproval: false
      },
      {
        idempotencyKey: "task-create-1",
        requestFingerprint: "fingerprint-a"
      }
    );
    const second = await repo.createTaskIdempotent(
      {
        workspaceId: workspace.id,
        title: "same task",
        request: "do the same thing",
        requiresApproval: false
      },
      {
        idempotencyKey: "task-create-1",
        requestFingerprint: "fingerprint-a"
      }
    );

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(first.resource.id, second.resource.id);
  });

  test("orphaned planning tasks can be recovered back to queued", async () => {
    const workspace = await repo.ensureWorkspace(`orphan-${randomUUID()}`, process.cwd());
    const task = await repo.createTask({
      workspaceId: workspace.id,
      title: "orphan task",
      request: "stuck during planning"
    });
    await repo.claimNextTask("worker-orphan");

    await pool.query(
      `update public.salvo_tasks
       set claimed_at = now() - interval '10 minutes'
       where id = $1`,
      [task.id]
    );

    const orphaned = await repo.findOrphanedTasks(60, 10);
    assert.equal(orphaned.some((item) => item.id === task.id), true);

    const recovered = await repo.recoverOrphanedTask(task.id);
    assert.equal(recovered.status, "queued");
    assert.equal(recovered.claimed_at, null);
  });

  test("cancel run moves run/task to cancelled and appends cancellation event", async () => {
    const { run, task } = await createBasicRun();

    await repo.transitionRunStatus(run.id, "starting");
    await repo.transitionRunStatus(run.id, "running");
    await repo.transitionTaskStatus(task.id, "planning");
    await repo.transitionTaskStatus(task.id, "running");

    const cancelled = await repo.cancelRun(run.id);
    assert.equal(cancelled.run.status, "cancelled");
    assert.equal(cancelled.task.status, "cancelled");

    const events = await repo.listRunEvents(run.id);
    assert.equal(events.some((event) => event.event_type === "run.cancelled"), true);
  });

  test("request run cancellation marks run and clears queue after cancellation", async () => {
    const { run, task } = await createBasicRun();

    await repo.transitionRunStatus(run.id, "starting");
    await repo.transitionRunStatus(run.id, "running");
    await repo.transitionTaskStatus(task.id, "planning");
    await repo.transitionTaskStatus(task.id, "running");

    const requested = await repo.requestRunCancellation(run.id);
    assert.notEqual(requested.cancellation_requested_at, null);

    const queue = await repo.listCancellationRequestedRuns(10);
    assert.equal(queue.some((item) => item.id === run.id), true);

    const requestEvents = await repo.listRunEvents(run.id);
    assert.equal(requestEvents.some((event) => event.event_type === "run.cancel_requested"), true);

    await repo.cancelRun(run.id);
    const queueAfterCancel = await repo.listCancellationRequestedRuns(10);
    assert.equal(queueAfterCancel.some((item) => item.id === run.id), false);
  });

  test("research/memory context excludes rejected entries and ranks by confidence", async () => {
    const workspace = await repo.ensureWorkspace(`ctx-${randomUUID()}`, process.cwd());

    await repo.createResearchDocument({
      workspaceId: workspace.id,
      title: "low confidence",
      topic: "test",
      bodyMarkdown: "a",
      sourceRunIds: [randomUUID()],
      confidence: 0.2,
      reviewStatus: "unreviewed"
    });

    await repo.createResearchDocument({
      workspaceId: workspace.id,
      title: "high confidence",
      topic: "test",
      bodyMarkdown: "b",
      sourceRunIds: [randomUUID()],
      confidence: 0.9,
      reviewStatus: "accepted"
    });

    await repo.createResearchDocument({
      workspaceId: workspace.id,
      title: "rejected",
      topic: "test",
      bodyMarkdown: "c",
      sourceRunIds: [randomUUID()],
      confidence: 1,
      reviewStatus: "rejected"
    });

    await repo.createMemory({
      workspaceId: workspace.id,
      sourceRunIds: [randomUUID()],
      memoryType: "note",
      title: "memory rejected",
      summary: "x",
      bodyMarkdown: "x",
      tags: [],
      confidence: 1,
      reviewStatus: "rejected"
    });

    await repo.createMemory({
      workspaceId: workspace.id,
      sourceRunIds: [randomUUID()],
      memoryType: "note",
      title: "memory accepted",
      summary: "x",
      bodyMarkdown: "x",
      tags: [],
      confidence: 0.6,
      reviewStatus: "accepted"
    });

    const research = await repo.listResearchContext(workspace.id, 10);
    const memory = await repo.listMemoryContext(workspace.id, 10);

    assert.equal(research.length, 2);
    assert.ok(research[0].confidence >= research[1].confidence);
    assert.ok(research.every((entry) => entry.review_status !== "rejected"));

    assert.equal(memory.length, 1);
    assert.equal(memory[0].review_status, "accepted");
  });

  test("research ingestion candidates include only completed/failed runs with evaluations", async () => {
    const completed = await createBasicRun();
    await repo.transitionRunStatus(completed.run.id, "starting");
    await repo.transitionRunStatus(completed.run.id, "running");
    await repo.transitionRunStatus(completed.run.id, "completed");
    await repo.recordEvaluation({
      runId: completed.run.id,
      contractId: completed.contract.id,
      passed: true,
      score: 92,
      outcome: "passed",
      findings: []
    });

    const failed = await createBasicRun();
    await repo.transitionRunStatus(failed.run.id, "starting");
    await repo.transitionRunStatus(failed.run.id, "running");
    await repo.transitionRunStatus(failed.run.id, "failed");
    await repo.recordEvaluation({
      runId: failed.run.id,
      contractId: failed.contract.id,
      passed: false,
      score: 34,
      outcome: "failed",
      findings: ["failing assertion"]
    });

    const blocked = await createBasicRun();
    await repo.transitionRunStatus(blocked.run.id, "starting");
    await repo.transitionRunStatus(blocked.run.id, "running");
    await repo.transitionRunStatus(blocked.run.id, "blocked");
    await repo.recordEvaluation({
      runId: blocked.run.id,
      contractId: blocked.contract.id,
      passed: false,
      score: 10,
      outcome: "hard_failed",
      hardFailReason: "policy",
      findings: ["policy denial"]
    });

    const candidates = await repo.listResearchIngestionCandidates(20);
    const candidateRunIds = new Set(candidates.map((entry) => entry.run_id));
    assert.equal(candidateRunIds.has(completed.run.id), true);
    assert.equal(candidateRunIds.has(failed.run.id), true);
    assert.equal(candidateRunIds.has(blocked.run.id), false);

    const completedCandidate = candidates.find((entry) => entry.run_id === completed.run.id);
    assert.ok(completedCandidate);
    await repo.recordResearchIngestion(completedCandidate);

    const afterIngest = await repo.listResearchIngestionCandidates(20);
    assert.equal(afterIngest.some((entry) => entry.run_id === completed.run.id), false);
  });

  test("contract memory context returns accepted memories for matching family only", async () => {
    const workspace = await repo.ensureWorkspace(`family-${randomUUID()}`, process.cwd());

    await repo.createMemory({
      workspaceId: workspace.id,
      sourceRunIds: [randomUUID()],
      contractFamilyKey: "family-alpha",
      memoryType: "research_experiment",
      title: "accepted alpha",
      summary: "summary",
      bodyMarkdown: "markdown",
      tags: [],
      confidence: 0.8,
      reviewStatus: "accepted"
    });

    await repo.createMemory({
      workspaceId: workspace.id,
      sourceRunIds: [randomUUID()],
      contractFamilyKey: "family-alpha",
      memoryType: "research_experiment",
      title: "unreviewed alpha",
      summary: "summary",
      bodyMarkdown: "markdown",
      tags: [],
      confidence: 0.9,
      reviewStatus: "unreviewed"
    });

    await repo.createMemory({
      workspaceId: workspace.id,
      sourceRunIds: [randomUUID()],
      contractFamilyKey: "family-beta",
      memoryType: "research_experiment",
      title: "accepted beta",
      summary: "summary",
      bodyMarkdown: "markdown",
      tags: [],
      confidence: 0.95,
      reviewStatus: "accepted"
    });

    const familyAlpha = await repo.listContractMemoryContext(workspace.id, "family-alpha", 10);
    assert.equal(familyAlpha.length, 1);
    assert.equal(familyAlpha[0].review_status, "accepted");
  });

  test("pending experiment families respect minimum sample size of 15", async () => {
    const workspace = await repo.ensureWorkspace(`threshold-${randomUUID()}`, process.cwd());

    const seedRun = async (index: number) => {
      const task = await repo.createTask({
        workspaceId: workspace.id,
        title: `threshold-${index}`,
        request: "threshold test request",
        requiresApproval: false
      });
      const contract = await repo.createContract({
        taskId: task.id,
        risk: "low",
        status: "active",
        contractJson: {
          schema_version: 1,
          family_key: "family-threshold",
          category: "general"
        }
      });
      const run = await repo.createRun({
        taskId: task.id,
        contractId: contract.id,
        agentProfile: "builder",
        workerId: "worker-threshold"
      });
      await repo.transitionRunStatus(run.id, "starting");
      await repo.transitionRunStatus(run.id, "running");
      await repo.transitionRunStatus(run.id, index % 2 === 0 ? "completed" : "failed");
      await repo.recordEvaluation({
        runId: run.id,
        contractId: contract.id,
        passed: index % 2 === 0,
        score: index % 2 === 0 ? 90 : 45,
        outcome: index % 2 === 0 ? "passed" : "failed",
        findings: []
      });
    };

    for (let i = 0; i < 14; i += 1) {
      await seedRun(i);
    }

    const firstBatch = await repo.listResearchIngestionCandidates(100);
    for (const candidate of firstBatch) {
      await repo.recordResearchIngestion(candidate);
    }

    const belowThreshold = await repo.listPendingExperimentFamilies(15, 10);
    assert.equal(
      belowThreshold.some((entry) => entry.contract_family_key === "family-threshold"),
      false
    );

    await seedRun(14);
    const secondBatch = await repo.listResearchIngestionCandidates(100);
    for (const candidate of secondBatch) {
      await repo.recordResearchIngestion(candidate);
    }

    const atThreshold = await repo.listPendingExperimentFamilies(15, 10);
    assert.equal(
      atThreshold.some((entry) => entry.contract_family_key === "family-threshold"),
      true
    );
  });

  test("integration config can be upserted and listed", async () => {
    const saved = await repo.upsertIntegrationConfig("process", {
      command: "pnpm test"
    });
    assert.equal(saved.integration_key, "process");

    const rows = await repo.listIntegrationConfigs();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].integration_key, "process");
    assert.equal(rows[0].config_json.command, "pnpm test");
  });

  test("0006 migration converts legacy claude_local config into llm_api", async () => {
    const migrationDir = path.resolve(rootDir, "supabase/migrations");
    const migration0005 = await readFile(path.join(migrationDir, "0005_integration_configs.sql"), "utf8");
    const migration0006 = await readFile(path.join(migrationDir, "0006_llm_api_integration_cutover.sql"), "utf8");

    await pool.query(`drop table if exists public.salvo_integration_configs cascade`);
    await pool.query(migration0005);
    await pool.query(
      `insert into public.salvo_integration_configs (integration_key, config_json)
       values ('claude_local', '{"authToken":"legacy-key","defaultModel":"claude-3-7-sonnet"}'::jsonb)`
    );

    await pool.query(migration0006);

    const rows = await pool.query<{
      integration_key: string;
      config_json: Record<string, unknown>;
    }>(`select integration_key, config_json from public.salvo_integration_configs order by integration_key asc`);

    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].integration_key, "llm_api");
    assert.equal(rows.rows[0].config_json.provider, "anthropic");
    assert.equal(rows.rows[0].config_json.apiKey, "legacy-key");
    assert.equal(rows.rows[0].config_json.defaultModel, "claude-3-7-sonnet");
  });

  test("0006 migration merges existing llm_api with claude_local and keeps llm_api precedence", async () => {
    const migrationDir = path.resolve(rootDir, "supabase/migrations");
    const migration0005 = await readFile(path.join(migrationDir, "0005_integration_configs.sql"), "utf8");
    const migration0006 = await readFile(path.join(migrationDir, "0006_llm_api_integration_cutover.sql"), "utf8");

    await pool.query(`drop table if exists public.salvo_integration_configs cascade`);
    await pool.query(migration0005);
    await pool.query(`
      do $$
      declare
        c text;
      begin
        select conname into c
        from pg_constraint
        where conrelid = 'public.salvo_integration_configs'::regclass
          and contype = 'c'
        limit 1;
        if c is not null then
          execute format('alter table public.salvo_integration_configs drop constraint %I', c);
        end if;
      end
      $$;
    `);
    await pool.query(`
      alter table public.salvo_integration_configs
        add constraint salvo_integration_configs_integration_key_check
        check (integration_key in ('supabase','llm_api','claude_local','process','http'))
    `);

    await pool.query(
      `insert into public.salvo_integration_configs (integration_key, config_json)
       values
       ('claude_local', '{"authToken":"legacy-key","baseUrl":"https://legacy.example/v1"}'::jsonb),
       ('llm_api', '{"provider":"openai","apiKey":"new-key","defaultModel":"gpt-5"}'::jsonb)`
    );

    await pool.query(migration0006);

    const rows = await pool.query<{
      integration_key: string;
      config_json: Record<string, unknown>;
    }>(`select integration_key, config_json from public.salvo_integration_configs order by integration_key asc`);

    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].integration_key, "llm_api");
    assert.equal(rows.rows[0].config_json.provider, "openai");
    assert.equal(rows.rows[0].config_json.apiKey, "new-key");
    assert.equal(rows.rows[0].config_json.defaultModel, "gpt-5");
    assert.equal(rows.rows[0].config_json.baseUrl, "https://legacy.example/v1");
  });
}
