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
      "0004_run_cancellation.sql"
    ]) {
      const sql = await readFile(path.join(migrationDir, fileName), "utf8");
      await pool.query(sql);
    }
  }

  async function resetTables(): Promise<void> {
    await pool.query(`
      truncate table
        public.salvo_memories,
        public.salvo_research_documents,
        public.salvo_evaluations,
        public.salvo_artifacts,
        public.salvo_run_events,
        public.salvo_runs,
        public.salvo_contracts,
        public.salvo_tasks,
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
}
