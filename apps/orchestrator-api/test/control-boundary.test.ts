import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
        public.audit_events,
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

  async function createTempArtifactPath(fileName: string, content: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "salvo-artifact-"));
    const target = path.join(dir, fileName);
    await writeFile(target, content, "utf8");
    return target;
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

  test("task creation replays original response for duplicate idempotency key", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: {
        idempotency_key: "task-idem-1"
      },
      payload: {
        title: "boundary-check",
        request: "create task only",
        requiresApproval: false
      }
    });
    const second = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: {
        idempotency_key: "task-idem-1"
      },
      payload: {
        title: "boundary-check",
        request: "create task only",
        requiresApproval: false
      }
    });

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.equal(first.json().id, second.json().id);
  });

  test("task creation rejects idempotency key reuse with a different payload", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: {
        idempotency_key: "task-idem-2"
      },
      payload: {
        title: "boundary-check",
        request: "create task only",
        requiresApproval: false
      }
    });
    assert.equal(first.statusCode, 201);

    const second = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: {
        idempotency_key: "task-idem-2"
      },
      payload: {
        title: "boundary-check changed",
        request: "create task only",
        requiresApproval: false
      }
    });

    assert.equal(second.statusCode, 409);
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

  test("root health endpoint remains public when API token auth is configured", async () => {
    const priorApiToken = process.env.SALVO_API_TOKEN;

    try {
      process.env.SALVO_API_TOKEN = "test-token";

      const response = await app.inject({
        method: "GET",
        url: "/health"
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().status, "ok");
    } finally {
      if (priorApiToken === undefined) {
        delete process.env.SALVO_API_TOKEN;
      } else {
        process.env.SALVO_API_TOKEN = priorApiToken;
      }
    }
  });

  test("protected endpoints require bearer auth when API token is configured", async () => {
    const priorApiToken = process.env.SALVO_API_TOKEN;

    try {
      process.env.SALVO_API_TOKEN = "test-token";

      const missingAuth = await app.inject({
        method: "GET",
        url: "/tasks"
      });
      assert.equal(missingAuth.statusCode, 401);
      assert.equal(
        missingAuth.json().error,
        "Missing Authorization header. Expected Bearer token."
      );

      const invalidAuth = await app.inject({
        method: "GET",
        url: "/tasks",
        headers: {
          authorization: "Bearer wrong-token"
        }
      });
      assert.equal(invalidAuth.statusCode, 401);
      assert.equal(invalidAuth.json().error, "Invalid bearer token.");

      const validAuth = await app.inject({
        method: "GET",
        url: "/tasks",
        headers: {
          authorization: "Bearer test-token"
        }
      });
      assert.equal(validAuth.statusCode, 200);
    } finally {
      if (priorApiToken === undefined) {
        delete process.env.SALVO_API_TOKEN;
      } else {
        process.env.SALVO_API_TOKEN = priorApiToken;
      }
    }
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

    const auditEvents = await pool.query<{
      action: string;
      target: string;
    }>(
      `select action, target
       from public.audit_events
       where action = 'task.approved'`
    );
    assert.equal(auditEvents.rows.length, 1);
    assert.equal(auditEvents.rows[0]?.target, task.id);
  });

  test("approve route replays original response for duplicate idempotency key", async () => {
    const workspace = await repo.ensureWorkspace(`approve-idem-${randomUUID()}`, process.cwd());
    const task = await repo.createTask({
      workspaceId: workspace.id,
      title: "approve review",
      request: "schema migration install dependencies",
      requiresApproval: false
    });
    await repo.transitionTaskStatus(task.id, "planning");
    await repo.transitionTaskStatus(task.id, "needs_review");

    const first = await app.inject({
      method: "POST",
      url: `/tasks/${task.id}/approve`,
      headers: {
        idempotency_key: "approve-idem-1"
      }
    });
    const second = await app.inject({
      method: "POST",
      url: `/tasks/${task.id}/approve`,
      headers: {
        idempotency_key: "approve-idem-1"
      }
    });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.json().approved_at, second.json().approved_at);
    assert.equal(first.json().status, second.json().status);
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

  test("research experiment endpoints list and review experiments", async () => {
    const workspace = await repo.ensureWorkspace(`exp-${randomUUID()}`, process.cwd());
    const experiment = await repo.createResearchExperiment({
      workspaceId: workspace.id,
      familyKey: "family-seed",
      category: "general",
      subcategory: null,
      sampleSize: 15,
      sourceDigest: "seed-digest",
      sourceRunIds: [randomUUID()],
      metricsJson: {
        pass_rate: 0.5
      },
      bodyMarkdown: "# experiment",
      confidence: 0.6,
      reviewStatus: "unreviewed"
    });

    const listResponse = await app.inject({
      method: "GET",
      url: "/research/experiments?status=unreviewed"
    });
    assert.equal(listResponse.statusCode, 200);
    const rows = listResponse.json();
    assert.equal(rows.some((item: { id: string }) => item.id === experiment.experiment.id), true);

    const reviewResponse = await app.inject({
      method: "POST",
      url: `/research/experiments/${experiment.experiment.id}/review`,
      payload: {
        status: "accepted"
      }
    });
    assert.equal(reviewResponse.statusCode, 200);

    const accepted = await app.inject({
      method: "GET",
      url: "/research/experiments?status=accepted"
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(
      accepted.json().some((item: { id: string }) => item.id === experiment.experiment.id),
      true
    );
  });

  test("run detail returns artifacts and final payload proof fields", async () => {
    const seeded = await seedRun("running");
    const artifactPath = await createTempArtifactPath("run-summary.md", "# Summary");

    await repo.createArtifact({
      runId: seeded.run.id,
      taskId: seeded.task.id,
      artifactType: "markdown",
      path: artifactPath,
      metadataJson: {
        label: "run summary"
      }
    });
    await repo.appendRunEvent(seeded.run.id, "run.final_payload", "info", {
      status: "completed",
      deliverables: ["run-summary.md"]
    });

    const response = await app.inject({
      method: "GET",
      url: `/runs/${seeded.run.id}`
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(Array.isArray(body.artifacts), true);
    assert.equal(body.artifacts.length, 1);
    assert.equal(body.artifacts[0].path, artifactPath);
    assert.equal(body.final_payload.deliverables[0], "run-summary.md");
  });

  test("artifact preview endpoint returns text and content endpoints", async () => {
    const seeded = await seedRun("running");
    const artifactPath = await createTempArtifactPath("proof.md", "hello proof preview");

    await repo.createArtifact({
      runId: seeded.run.id,
      taskId: seeded.task.id,
      artifactType: "markdown",
      path: artifactPath,
      metadataJson: {
        label: "proof"
      }
    });

    const detail = await app.inject({
      method: "GET",
      url: `/runs/${seeded.run.id}`
    });
    const artifactId = detail.json().artifacts[0].id as string;

    const preview = await app.inject({
      method: "GET",
      url: `/artifacts/${artifactId}/preview`
    });
    assert.equal(preview.statusCode, 200);
    const previewBody = preview.json();
    assert.equal(previewBody.kind, "text");
    assert.ok((previewBody.content as string).includes("hello proof preview"));

    const content = await app.inject({
      method: "GET",
      url: `/artifacts/${artifactId}/content`
    });
    assert.equal(content.statusCode, 200);
    assert.ok(content.body.includes("hello proof preview"));
  });

  test("integrations and cost metrics endpoints return realtime payloads", async () => {
    const seeded = await seedRun("running");
    await repo.appendRunEvent(seeded.run.id, "usage.reported", "info", {
      model: "gpt-5-mini",
      input_tokens: 120,
      output_tokens: 40,
      cost_usd: 0.0012,
      estimated: true
    });

    const integrations = await app.inject({
      method: "GET",
      url: "/integrations"
    });
    assert.equal(integrations.statusCode, 200);
    assert.ok(Array.isArray(integrations.json()));
    assert.ok(integrations.json().length >= 4);

    const costs = await app.inject({
      method: "GET",
      url: "/metrics/costs"
    });
    assert.equal(costs.statusCode, 200);
    const costBody = costs.json();
    assert.equal(costBody.estimated, false);
    assert.equal(typeof costBody.totals.cost_usd, "number");
    assert.equal(Array.isArray(costBody.by_model), true);
    assert.ok(costBody.by_model.some((entry: { model: string }) => entry.model === "gpt-5-mini"));

    const llmRow = integrations
      .json()
      .find((item: { key: string }) => item.key === "llm_api");
    assert.ok(llmRow);
  });

  test("budget endpoints persist limits and return spend state", async () => {
    const workspace = await repo.ensureWorkspace(`budget-api-${randomUUID()}`, process.cwd());
    const task = await repo.createTask({
      workspaceId: workspace.id,
      title: "budget task",
      request: "budget request",
      requiresApproval: false
    });
    const contract = await repo.createContract({
      taskId: task.id,
      risk: "low",
      status: "active",
      contractJson: {
        schema_version: 1,
        family_key: "family-budget-api",
        category: "general"
      }
    });
    const run = await repo.createRun({
      taskId: task.id,
      contractId: contract.id,
      agentProfile: "builder",
      workerId: "budget-worker"
    });
    await repo.appendRunEvent(run.id, "usage.reported", "info", {
      model: "gpt-5-mini",
      input_tokens: 120,
      output_tokens: 40,
      cost_usd: 0.5,
      estimated: false
    });

    const workspaceLimit = await app.inject({
      method: "POST",
      url: "/budgets",
      payload: {
        workspaceId: workspace.id,
        limitUsd: 10
      }
    });
    assert.equal(workspaceLimit.statusCode, 200);
    assert.equal(workspaceLimit.json().ok, true);

    const familyLimit = await app.inject({
      method: "POST",
      url: "/budgets",
      payload: {
        workspaceId: workspace.id,
        contractFamilyKey: "family-budget-api",
        limitUsd: 1
      }
    });
    assert.equal(familyLimit.statusCode, 200);
    assert.equal(familyLimit.json().ok, true);

    const overview = await app.inject({
      method: "GET",
      url: "/budgets"
    });
    assert.equal(overview.statusCode, 200);
    const payload = overview.json();
    assert.equal(payload.workspaces.some((entry: { id: string }) => entry.id === workspace.id), true);
    assert.equal(payload.budgets.length, 2);
    assert.equal(
      payload.budgets.some(
        (entry: { scope: string; spent_usd: number; remaining_usd: number }) =>
          entry.scope === "workspace" && entry.spent_usd === 0.5 && entry.remaining_usd === 9.5
      ),
      true
    );
    assert.equal(
      payload.budgets.some(
        (entry: { contract_family_key: string | null; remaining_usd: number }) =>
          entry.contract_family_key === "family-budget-api" && entry.remaining_usd === 0.5
      ),
      true
    );
  });

  test("trust tier endpoints expose defaults and persist manual overrides", async () => {
    const workspace = await repo.ensureWorkspace(`trust-api-${randomUUID()}`, process.cwd());

    const initial = await app.inject({
      method: "GET",
      url: "/trust-tiers"
    });
    assert.equal(initial.statusCode, 200);
    const initialPayload = initial.json();
    assert.equal(
      initialPayload.tiers.some(
        (entry: {
          workspace_id: string;
          agent_profile: string;
          trust_tier: string;
          managed_by: string;
        }) =>
          entry.workspace_id === workspace.id &&
          entry.agent_profile === "builder" &&
          entry.trust_tier === "standard" &&
          entry.managed_by === "system"
      ),
      true
    );

    const saved = await app.inject({
      method: "POST",
      url: "/trust-tiers",
      payload: {
        workspaceId: workspace.id,
        agentProfile: "builder",
        trustTier: "probation"
      }
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().ok, true);

    const afterSave = await app.inject({
      method: "GET",
      url: "/trust-tiers"
    });
    assert.equal(afterSave.statusCode, 200);
    assert.equal(
      afterSave
        .json()
        .tiers.some(
          (entry: {
            workspace_id: string;
            agent_profile: string;
            trust_tier: string;
            managed_by: string;
          }) =>
            entry.workspace_id === workspace.id &&
            entry.agent_profile === "builder" &&
            entry.trust_tier === "probation" &&
            entry.managed_by === "manual"
        ),
      true
    );
  });

  test("integration config update endpoint persists llm_api settings", async () => {
    const update = await app.inject({
      method: "POST",
      url: "/integrations/llm_api/config",
      payload: {
        provider: "openai",
        apiKey: "test-key",
        baseUrl: "https://api.example.com/v1",
        defaultModel: "gpt-5"
      }
    });

    assert.equal(update.statusCode, 200);
    assert.equal(update.json().ok, true);

    const integrations = await app.inject({
      method: "GET",
      url: "/integrations"
    });
    assert.equal(integrations.statusCode, 200);

    const llmRow = integrations
      .json()
      .find((item: { key: string }) => item.key === "llm_api");
    assert.equal(llmRow.config.provider, "openai");
    assert.equal(llmRow.config.base_url, "https://api.example.com/v1");
    assert.equal(llmRow.config.default_model, "gpt-5");
    assert.equal(llmRow.config.api_key_configured, true);
  });

  test("integrations endpoint uses env fallback SALVO_LLM_API_KEY then legacy SALVO_CLAUDE_AUTH_TOKEN", async () => {
    const priorLlmKey = process.env.SALVO_LLM_API_KEY;
    const priorClaudeKey = process.env.SALVO_CLAUDE_AUTH_TOKEN;
    const priorProvider = process.env.SALVO_LLM_PROVIDER;

    try {
      process.env.SALVO_LLM_PROVIDER = "anthropic";
      process.env.SALVO_LLM_API_KEY = "llm-fallback-key";
      delete process.env.SALVO_CLAUDE_AUTH_TOKEN;

      const withLlmKey = await app.inject({
        method: "GET",
        url: "/integrations"
      });
      const llmWithPrimary = withLlmKey
        .json()
        .find((item: { key: string }) => item.key === "llm_api");
      assert.equal(llmWithPrimary.status, "ready");
      assert.equal(llmWithPrimary.config.api_key_configured, true);

      delete process.env.SALVO_LLM_API_KEY;
      process.env.SALVO_CLAUDE_AUTH_TOKEN = "legacy-fallback-key";

      const withLegacyKey = await app.inject({
        method: "GET",
        url: "/integrations"
      });
      const llmWithLegacy = withLegacyKey
        .json()
        .find((item: { key: string }) => item.key === "llm_api");
      assert.equal(llmWithLegacy.status, "ready");
      assert.equal(llmWithLegacy.config.api_key_configured, true);
    } finally {
      if (priorLlmKey === undefined) {
        delete process.env.SALVO_LLM_API_KEY;
      } else {
        process.env.SALVO_LLM_API_KEY = priorLlmKey;
      }

      if (priorClaudeKey === undefined) {
        delete process.env.SALVO_CLAUDE_AUTH_TOKEN;
      } else {
        process.env.SALVO_CLAUDE_AUTH_TOKEN = priorClaudeKey;
      }

      if (priorProvider === undefined) {
        delete process.env.SALVO_LLM_PROVIDER;
      } else {
        process.env.SALVO_LLM_PROVIDER = priorProvider;
      }
    }
  });

  test("legacy claude_local integration key is rejected by config update endpoint", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/integrations/claude_local/config",
      payload: {
        authToken: "legacy"
      }
    });

    assert.equal(response.statusCode, 400);
  });

  test("task creation validates title length with field-specific errors", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: {
        title: "x".repeat(161),
        request: "create task only",
        requiresApproval: false
      }
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "Invalid request body.");
    assert.deepEqual(response.json().issues, [
      {
        path: "title",
        message: "Title must be 160 characters or fewer."
      }
    ]);
  });

  test("oversized request bodies are rejected", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: {
        title: "oversized",
        request: "x".repeat(1_100_000),
        requiresApproval: false
      }
    });

    assert.equal(response.statusCode, 413);
    assert.equal(response.json().error, "Request body too large.");
    assert.equal(response.json().limit_bytes, 1_048_576);
  });

  test("rate limiting returns 429 with retry-after", async () => {
    let limitedResponse;
    for (let index = 0; index <= 60; index += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/health"
      });

      if (index < 60) {
        assert.equal(response.statusCode, 200);
      } else {
        limitedResponse = response;
      }
    }

    assert.ok(limitedResponse);
    assert.equal(limitedResponse.statusCode, 429);
    assert.equal(limitedResponse.json().error, "Rate limit exceeded.");
    assert.equal(typeof limitedResponse.headers["retry-after"], "string");
  });
}
