import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createDbPool, ResearchRepository, SalvoRepository } from "@salvo/db";
import { ResearchAnalysisService } from "../src/service";

const databaseUrl = process.env.SALVO_TEST_DATABASE_URL ?? process.env.SALVO_DATABASE_URL;
const enableIntegration = process.env.SALVO_RESEARCH_DAEMON_IT === "1";

if (!enableIntegration || !databaseUrl) {
  test(
    "research pipeline integration tests skipped (set SALVO_RESEARCH_DAEMON_IT=1 with DB URL)",
    { skip: true },
    () => {}
  );
} else {
  const pool = createDbPool(databaseUrl);
  const repo = new SalvoRepository(pool);
  const researchRepo = new ResearchRepository(pool);
  const service = new ResearchAnalysisService(researchRepo, 15);
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
      "0007_research_analysis_pipeline.sql"
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
        public.salvo_integration_configs,
        public.salvo_daemon_heartbeats,
        public.salvo_workspaces
      restart identity cascade
    `);
  }

  async function seedFamilyRuns(
    workspaceId: string,
    familyKey: string,
    count: number
  ): Promise<string[]> {
    const runIds: string[] = [];

    for (let i = 0; i < count; i += 1) {
      const task = await repo.createTask({
        workspaceId,
        title: `family run ${i}`,
        request: "integration connector reliability",
        requiresApproval: false
      });
      const contract = await repo.createContract({
        taskId: task.id,
        risk: "low",
        status: "active",
        contractJson: {
          schema_version: 1,
          category: "integration",
          subcategory: "external-api",
          family_key: familyKey
        }
      });
      const run = await repo.createRun({
        taskId: task.id,
        contractId: contract.id,
        agentProfile: "builder",
        workerId: "seed-worker"
      });

      await repo.transitionRunStatus(run.id, "starting");
      await repo.transitionRunStatus(run.id, "running");
      const completed = i % 2 === 0;
      await repo.transitionRunStatus(run.id, completed ? "completed" : "failed");

      await repo.recordEvaluation({
        runId: run.id,
        contractId: contract.id,
        passed: completed,
        score: completed ? 86 : 48,
        outcome: completed ? "passed" : "failed",
        findings: []
      });
      runIds.push(run.id);
    }

    return runIds;
  }

  before(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await resetTables();
  });

  after(async () => {
    await pool.end();
  });

  test("parallel research cycles are idempotent for experiments and publish", async () => {
    const workspace = await repo.ensureWorkspace(`parallel-${randomUUID()}`, process.cwd());
    const familyKey = "family-parallel";
    await seedFamilyRuns(workspace.id, familyKey, 15);

    await Promise.all([service.runCycle(), service.runCycle()]);

    const experiments = await repo.listResearchExperiments(10);
    assert.equal(experiments.length, 1);
    assert.equal(experiments[0].sample_size, 15);

    const findingCount = await pool.query<{ count: string }>(
      `select count(*)::text as count from public.salvo_research_findings`
    );
    assert.equal(Number(findingCount.rows[0].count), 1);

    const ingestionCoverage = await pool.query<{ count: string }>(
      `select count(*)::text as count
       from public.salvo_research_ingestions
       where experiment_id = $1`,
      [experiments[0].id]
    );
    assert.equal(Number(ingestionCoverage.rows[0].count), 15);

    await repo.setResearchExperimentReviewStatus(experiments[0].id, "accepted");
    await Promise.all([service.publishLoop(), service.publishLoop()]);

    const publishedMemories = await pool.query<{ count: string }>(
      `select count(*)::text as count
       from public.salvo_memories
       where contract_family_key = $1
         and memory_type = 'research_experiment'`,
      [familyKey]
    );
    assert.equal(Number(publishedMemories.rows[0].count), 1);
  });

  test("end-to-end flow creates experiment at N=15 and injects accepted family memory", async () => {
    const workspace = await repo.ensureWorkspace(`e2e-${randomUUID()}`, process.cwd());
    const familyKey = "family-e2e";
    const sourceRunIds = await seedFamilyRuns(workspace.id, familyKey, 15);

    await service.runCycle();

    const unreviewedExperiments = await repo.listResearchExperiments(10, "unreviewed");
    assert.equal(unreviewedExperiments.length, 1);
    assert.equal(unreviewedExperiments[0].sample_size, 15);

    await repo.setResearchExperimentReviewStatus(unreviewedExperiments[0].id, "accepted");
    await service.runCycle();

    const familyMemory = await repo.listContractMemoryContext(workspace.id, familyKey, 10);
    assert.equal(familyMemory.length, 1);
    assert.equal(familyMemory[0].review_status, "accepted");
    assert.equal(familyMemory[0].source_run_ids.length, 15);
    assert.deepEqual(
      new Set(familyMemory[0].source_run_ids),
      new Set(sourceRunIds)
    );
  });
}
