import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createDbPool, SalvoRepository } from "@salvo/db";
import { buildServer } from "../src/index";

const databaseUrl = process.env.SALVO_TEST_DATABASE_URL ?? process.env.SALVO_DATABASE_URL;

if (!databaseUrl) {
  test("api boundary tests skipped (no SALVO_TEST_DATABASE_URL or SALVO_DATABASE_URL)", { skip: true }, () => {});
} else {
  process.env.SALVO_DATABASE_URL = databaseUrl;

  const pool = createDbPool(databaseUrl);
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

  const app = await buildServer();

  before(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await resetTables();
  });

  after(async () => {
    await app.close();
    await repo.close();
  });

  async function seedRun(status: "failed" | "running") {
    const workspace = await repo.ensureWorkspace(`api-test-${randomUUID()}`, process.cwd());
    const task = await repo.createTask({
      workspaceId: workspace.id,
      title: `task-${status}`,
      request: "seed run",
      requiresApproval: false
    });

    const contract = await repo.createContract({
      taskId: task.id,
      risk: "low",
      status: "active",
      contractJson: { schema_version: 1 }
    });

    const run = await repo.createRun({
      taskId: task.id,
      contractId: contract.id,
      agentProfile: "builder",
      workerId: "seed-worker"
    });

    await repo.transitionRunStatus(run.id, "starting");
    await repo.transitionRunStatus(run.id, "running");
    await repo.transitionTaskStatus(task.id, "planning");
    await repo.transitionTaskStatus(task.id, "running");

    if (status === "failed") {
      await repo.transitionRunStatus(run.id, "failed");
      await repo.transitionTaskStatus(task.id, "failed");
    }

    return { run, task };
  }

  test("control-plane task creation does not create a run", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: {
        title: "boundary-check",
        request: "create task only",
        requiresApproval: false
      }
    });

    assert.equal(createResponse.statusCode, 201);

    const runsResponse = await app.inject({
      method: "GET",
      url: "/runs"
    });

    assert.equal(runsResponse.statusCode, 200);
    const runs = runsResponse.json();
    assert.equal(Array.isArray(runs), true);
    assert.equal(runs.length, 0);
  });

  test("health endpoints return offline when no daemon heartbeat exists", async () => {
    const orchestrator = await app.inject({
      method: "GET",
      url: "/health/orchestrator"
    });

    const research = await app.inject({
      method: "GET",
      url: "/health/research"
    });

    assert.equal(orchestrator.statusCode, 200);
    assert.equal(research.statusCode, 200);
    assert.equal(orchestrator.json().status, "offline");
    assert.equal(research.json().status, "offline");
  });

  test("restart endpoint validates target", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/control/restart",
      payload: {
        target: "invalid"
      }
    });

    assert.equal(response.statusCode, 400);
  });

  test("retry endpoint re-queues task for failed run", async () => {
    const seeded = await seedRun("failed");

    const response = await app.inject({
      method: "POST",
      url: `/runs/${seeded.run.id}/retry`
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.equal(body.task.status, "queued");
  });

  test("cancel endpoint cancels active run and task", async () => {
    const seeded = await seedRun("running");

    const response = await app.inject({
      method: "POST",
      url: `/runs/${seeded.run.id}/cancel`
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.equal(body.requested, true);

    const run = await repo.getRun(seeded.run.id);
    assert.equal(run?.status, "running");
    assert.notEqual(run?.cancellation_requested_at, null);
  });

  test("reject task route marks needs_review task failed", async () => {
    const workspace = await repo.ensureWorkspace(`review-${randomUUID()}`, process.cwd());
    const task = await repo.createTask({
      workspaceId: workspace.id,
      title: "needs review",
      request: "schema migration install dependencies",
      requiresApproval: false
    });
    await repo.transitionTaskStatus(task.id, "planning");
    await repo.transitionTaskStatus(task.id, "needs_review");

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${task.id}/reject`
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "failed");
  });

  test("approve route moves needs_review task back to queued", async () => {
    const workspace = await repo.ensureWorkspace(`approve-${randomUUID()}`, process.cwd());
    const task = await repo.createTask({
      workspaceId: workspace.id,
      title: "approve review",
      request: "schema migration install dependencies",
      requiresApproval: false
    });
    await repo.transitionTaskStatus(task.id, "planning");
    await repo.transitionTaskStatus(task.id, "needs_review");

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${task.id}/approve`
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "queued");
    assert.notEqual(response.json().approved_at, null);
  });

  test("research and memory review endpoints update review status", async () => {
    const workspace = await repo.ensureWorkspace(`review-docs-${randomUUID()}`, process.cwd());
    const sourceRunId = randomUUID();

    await repo.createResearchDocument({
      workspaceId: workspace.id,
      title: "doc",
      topic: "postmortem",
      bodyMarkdown: "content",
      sourceRunIds: [sourceRunId],
      confidence: 0.7,
      reviewStatus: "unreviewed"
    });

    await repo.createMemory({
      workspaceId: workspace.id,
      sourceRunIds: [sourceRunId],
      memoryType: "best_practice",
      title: "memory",
      summary: "summary",
      bodyMarkdown: "markdown",
      tags: [],
      confidence: 0.6,
      reviewStatus: "unreviewed"
    });

    const researchList = await app.inject({
      method: "GET",
      url: "/research?status=unreviewed"
    });
    assert.equal(researchList.statusCode, 200);
    const researchRows = researchList.json();
    assert.equal(researchRows.length, 1);
    const researchId = researchRows[0].id as string;

    const memoryList = await app.inject({
      method: "GET",
      url: "/memories?status=unreviewed"
    });
    assert.equal(memoryList.statusCode, 200);
    const memoryRows = memoryList.json();
    assert.equal(memoryRows.length, 1);
    const memoryId = memoryRows[0].id as string;

    const reviewResearch = await app.inject({
      method: "POST",
      url: `/research/${researchId}/review`,
      payload: {
        status: "accepted"
      }
    });
    assert.equal(reviewResearch.statusCode, 200);

    const reviewMemory = await app.inject({
      method: "POST",
      url: `/memories/${memoryId}/review`,
      payload: {
        status: "rejected"
      }
    });
    assert.equal(reviewMemory.statusCode, 200);

    const acceptedResearch = await repo.listResearchDocuments(10, "accepted");
    assert.equal(acceptedResearch.some((item) => item.id === researchId), true);
    const rejectedMemories = await repo.listMemories(10, "rejected");
    assert.equal(rejectedMemories.some((item) => item.id === memoryId), true);
  });
}
