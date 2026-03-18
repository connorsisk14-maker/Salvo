import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { TaskPriority } from "@salvo/shared";
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
      public.salvo_run_checkpoints,
      public.salvo_runs,
        public.salvo_contracts,
        public.salvo_task_chat_messages,
        public.salvo_task_chat_sessions,
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
      requiresApproval: false,
      priority: "urgent"
    });

    const [workerA, workerB] = await Promise.all([
      repo.claimNextTask("worker-a"),
      repo.claimNextTask("worker-b")
    ]);

    const claimed = [workerA, workerB].filter(Boolean);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.id, task.id);
    assert.equal(claimed[0]?.priority, "urgent");
  });

  test("claimNextTask honors priority order before created_at", async () => {
    const workspace = await repo.ensureWorkspace(`priority-${randomUUID()}`, process.cwd());
    const priorities: Array<{ label: string; priority: TaskPriority }> = [
      { label: "task-low", priority: "low" },
      { label: "task-med", priority: "medium" },
      { label: "task-high", priority: "high" },
      { label: "task-urgent", priority: "urgent" }
    ];

    await Promise.all(
      priorities.map(({ label, priority }) =>
        repo.createTask({
          workspaceId: workspace.id,
          title: `priority ${label}`,
          request: `run ${label}`,
          priority
        })
      )
    );

    const expected = ["urgent", "high", "medium", "low"];
    const actual: string[] = [];

    for (let i = 0; i < expected.length; i += 1) {
      const claimed = await repo.claimNextTask(`worker-priority-${i}`);
      assert.ok(claimed, "expected a task to be claimed");
      actual.push(claimed?.priority ?? "");
    }

    assert.deepEqual(actual, expected);
  });

  test("tasks with pending dependencies block with the provided reason", async () => {
    const workspace = await repo.ensureWorkspace(`dep-${randomUUID()}`, process.cwd());
    const dependencyTask = await repo.createTask({
      workspaceId: workspace.id,
      title: "dependency source",
      request: "prepare baseline data",
      requiresApproval: false
    });

    const dependencyContract = await repo.createContract({
      taskId: dependencyTask.id,
      risk: "low",
      status: "active",
      contractJson: {
        schema_version: 1
      }
    });

    const dependentTask = await repo.createTask({
      workspaceId: workspace.id,
      title: "dependent work",
      request: "build on dependency",
      requiresApproval: false,
      dependencies: [
        {
          contractId: dependencyContract.id,
          reason: "awaiting baseline contract"
        }
      ]
    });

    assert.equal(dependentTask.status, "blocked");
    assert.equal(dependentTask.dependency_block_reason, "awaiting baseline contract");
    assert.ok(dependentTask.dependency_blocked_at);
  });

  test("completing a dependency run wakes blocked tasks", async () => {
    const workspace = await repo.ensureWorkspace(`dep-${randomUUID()}`, process.cwd());
    const dependencyTask = await repo.createTask({
      workspaceId: workspace.id,
      title: "dependency source",
      request: "prepare baseline data",
      requiresApproval: false
    });

    const dependencyContract = await repo.createContract({
      taskId: dependencyTask.id,
      risk: "low",
      status: "active",
      contractJson: {
        schema_version: 1
      }
    });

    const dependentTask = await repo.createTask({
      workspaceId: workspace.id,
      title: "dependent work",
      request: "build on dependency",
      requiresApproval: false,
      dependencies: [
        {
          contractId: dependencyContract.id,
          reason: "awaiting baseline contract"
        }
      ]
    });

    const dependencyRun = await repo.createRun({
      taskId: dependencyTask.id,
      contractId: dependencyContract.id,
      agentProfile: "builder",
      workerId: "worker-dep"
    });

    await repo.transitionRunStatus(dependencyRun.id, "provisioning");
    await repo.transitionRunStatus(dependencyRun.id, "starting");
    await repo.transitionRunStatus(dependencyRun.id, "running");
    await repo.transitionRunStatus(dependencyRun.id, "evaluating");
    await repo.transitionRunStatus(dependencyRun.id, "completed");

    const refreshed = await repo.getTask(dependentTask.id);
    assert.ok(refreshed);
    assert.equal(refreshed?.status, "queued");
    assert.equal(refreshed?.dependency_block_reason, null);
    assert.equal(refreshed?.dependency_blocked_at, null);
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

  test("task chat turns persist session state and history", async () => {
    const workspace = await repo.ensureWorkspace(`chat-${randomUUID()}`, process.cwd());

    const first = await repo.saveTaskChatTurn({
      workspaceId: workspace.id,
      userMessage: "help",
      assistantResponse: "Please clarify what should be built.",
      proposedContract: null
    });
    assert.equal(first.session.workspace_id, workspace.id);
    assert.equal(first.session.status, "active");

    const second = await repo.saveTaskChatTurn({
      sessionId: first.session.id,
      userMessage: "Implement task chat approvals with a persisted session.",
      assistantResponse: "Here is a proposal.",
      proposedContract: {
        title: "Implement task chat approvals with a persisted session.",
        request: "Implement task chat approvals with a persisted session.",
        risk: "medium",
        requires_approval: false,
        contract_json: {
          schema_version: 1,
          family_key: "family_chat_test",
          category: "general",
          risk: "medium",
          agent_profile: "builder"
        }
      }
    });
    assert.equal(second.session.id, first.session.id);
    assert.notEqual(second.session.pending_proposal_json, null);

    const messages = await repo.listTaskChatMessages(first.session.id);
    assert.equal(messages.length, 4);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[1].role, "assistant");
    assert.equal(messages[2].role, "user");
    assert.equal(messages[3].role, "assistant");
  });

  test("task chat proposal approval creates task/contract and replays idempotent responses", async () => {
    const workspace = await repo.ensureWorkspace(`chat-approve-${randomUUID()}`, process.cwd());
    const chat = await repo.saveTaskChatTurn({
      workspaceId: workspace.id,
      userMessage: "Create a task for chat proposal approval endpoint implementation.",
      assistantResponse: "Draft proposal ready.",
      proposedContract: {
        title: "Create a task for chat proposal approval endpoint implementation.",
        request: "Create a task for chat proposal approval endpoint implementation.",
        risk: "low",
        requires_approval: false,
        contract_json: {
          schema_version: 1,
          family_key: "family_chat_approve_test",
          category: "general",
          risk: "low",
          agent_profile: "builder",
          created_at: new Date().toISOString()
        }
      }
    });

    const firstApprove = await repo.approveTaskChatProposalIdempotent(chat.session.id, {
      idempotencyKey: "chat-approve-1",
      requestFingerprint: "chat-approve-fingerprint"
    });
    assert.equal(firstApprove.duplicate, false);
    assert.equal(firstApprove.resource.task.workspace_id, workspace.id);
    assert.equal(firstApprove.resource.contract.task_id, firstApprove.resource.task.id);
    assert.notEqual(firstApprove.resource.task.approved_at, null);
    assert.equal(firstApprove.resource.session.status, "approved");

    const secondApprove = await repo.approveTaskChatProposalIdempotent(chat.session.id, {
      idempotencyKey: "chat-approve-1",
      requestFingerprint: "chat-approve-fingerprint"
    });
    assert.equal(secondApprove.duplicate, true);
    assert.equal(secondApprove.resource.task.id, firstApprove.resource.task.id);
    assert.equal(secondApprove.resource.contract.id, firstApprove.resource.contract.id);
  });

  test("task chat approval uses proposal override when supplied", async () => {
    const workspace = await repo.ensureWorkspace(`chat-override-${randomUUID()}`, process.cwd());
    const chat = await repo.saveTaskChatTurn({
      workspaceId: workspace.id,
      userMessage: "Build a robust analytics endpoint.",
      assistantResponse: "Draft proposal ready.",
      proposedContract: {
        title: "Build a robust analytics endpoint.",
        request: "Build a robust analytics endpoint.",
        risk: "low",
        requires_approval: false,
        contract_json: {
          schema_version: 1,
          family_key: "family_chat_override_test",
          category: "general",
          risk: "low",
          agent_profile: "builder",
          created_at: new Date().toISOString()
        }
      }
    });

    const approved = await repo.approveTaskChatProposal(chat.session.id, {
      title: "Edited analytics endpoint title",
      request: "Edited analytics endpoint request with explicit acceptance.",
      risk: "medium",
      requires_approval: false,
      contract_json: {
        schema_version: 1,
        family_key: "family_chat_override_test",
        category: "general",
        risk: "medium",
        agent_profile: "builder",
        created_at: new Date().toISOString()
      }
    });

    assert.equal(approved.task.title, "Edited analytics endpoint title");
    assert.equal(approved.contract.risk, "medium");
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

  test("relevant memory retrieval combines family bias with semantic match", async () => {
    const workspace = await repo.ensureWorkspace(`memory-search-${randomUUID()}`, process.cwd());

    await repo.createMemory({
      workspaceId: workspace.id,
      sourceRunIds: [randomUUID()],
      contractFamilyKey: "family-hvac",
      memoryType: "research_experiment",
      title: "HVAC family baseline",
      summary: "Family-specific baseline guidance.",
      bodyMarkdown: "General advice for HVAC family work.",
      tags: ["hvac"],
      confidence: 0.55,
      reviewStatus: "accepted"
    });

    await repo.createMemory({
      workspaceId: workspace.id,
      sourceRunIds: [randomUUID()],
      contractFamilyKey: "family-ops",
      memoryType: "research_experiment",
      title: "Dispatch urgency wording",
      summary: "Emergency HVAC dispatch messaging converts better.",
      bodyMarkdown: "Use emergency dispatch wording for after-hours HVAC repairs and quote requests.",
      tags: ["dispatch", "hvac", "after-hours"],
      confidence: 0.9,
      reviewStatus: "accepted"
    });

    await repo.createMemory({
      workspaceId: workspace.id,
      sourceRunIds: [randomUUID()],
      contractFamilyKey: "family-random",
      memoryType: "research_experiment",
      title: "Unrelated memory",
      summary: "Completely different gardening content.",
      bodyMarkdown: "Seasonal pruning guidance for shade perennials and soil moisture management.",
      tags: ["gardening"],
      confidence: 1,
      reviewStatus: "accepted"
    });

    const promptContext = await repo.listRelevantMemoryPromptContext(
      workspace.id,
      "Need an HVAC emergency dispatch follow-up plan for after-hours repair leads.",
      "family-hvac",
      5
    );
    const referenceContext = await repo.listRelevantMemoryContext(
      workspace.id,
      "Need an HVAC emergency dispatch follow-up plan for after-hours repair leads.",
      "family-hvac",
      5
    );

    assert.equal(promptContext.length, 2);
    assert.equal(promptContext[0]?.title, "HVAC family baseline");
    assert.equal(promptContext[1]?.title, "Dispatch urgency wording");
    assert.deepEqual(
      referenceContext.map((entry) => entry.id),
      promptContext.map((entry) => entry.id)
    );
  });

  test("accepted experiment publishing creates linked memory and exposes it in contract memory context", async () => {
    const workspace = await repo.ensureWorkspace(`publish-${randomUUID()}`, process.cwd());
    const sourceRunIds = [randomUUID(), randomUUID(), randomUUID()];
    const created = await repo.createResearchExperiment({
      workspaceId: workspace.id,
      familyKey: "family-publish",
      category: "integration",
      subcategory: "memory",
      sampleSize: sourceRunIds.length,
      sourceDigest: `digest-${randomUUID()}`,
      sourceRunIds,
      metricsJson: {
        sample_size: sourceRunIds.length
      },
      bodyMarkdown: "## experiment body",
      confidence: 0.82,
      reviewStatus: "accepted"
    });

    await repo.createResearchFinding({
      experimentId: created.experiment.id,
      workspaceId: workspace.id,
      findingType: "experiment_summary",
      title: "finding title",
      bodyMarkdown: "finding body",
      confidence: 0.71
    });

    const firstPublish = await repo.publishAcceptedResearchExperiment(created.experiment.id);
    const secondPublish = await repo.publishAcceptedResearchExperiment(created.experiment.id);
    assert.equal(firstPublish, true);
    assert.equal(secondPublish, false);

    const familyMemory = await repo.listContractMemoryContext(workspace.id, "family-publish", 10);
    assert.equal(familyMemory.length, 1);
    assert.equal(familyMemory[0].review_status, "accepted");
    assert.equal(familyMemory[0].experiment_id, created.experiment.id);
    assert.deepEqual(new Set(familyMemory[0].source_run_ids), new Set(sourceRunIds));

    const memoryRow = await pool.query<{
      memory_type: string;
      review_status: "unreviewed" | "accepted" | "rejected";
      tags: string[];
      summary: string;
    }>(
      `select memory_type, review_status, tags, summary
       from public.salvo_memories
       where id = $1
       limit 1`,
      [familyMemory[0].id]
    );
    assert.equal(memoryRow.rows[0]?.memory_type, "research_experiment");
    assert.equal(memoryRow.rows[0]?.review_status, "accepted");
    assert.equal(memoryRow.rows[0]?.tags.includes(`experiment:${created.experiment.id}`), true);
    assert.equal(memoryRow.rows[0]?.summary.includes(created.experiment.id), true);

    const findingLink = await pool.query<{ published_memory_id: string | null }>(
      `select published_memory_id
       from public.salvo_research_findings
       where experiment_id = $1`,
      [created.experiment.id]
    );
    assert.equal(findingLink.rows.length, 1);
    assert.equal(findingLink.rows[0]?.published_memory_id, familyMemory[0].id);

    const experimentStatus = await pool.query<{ published_at: string | null }>(
      `select published_at
       from public.salvo_research_experiments
       where id = $1
       limit 1`,
      [created.experiment.id]
    );
    assert.notEqual(experimentStatus.rows[0]?.published_at, null);
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

  test("budget status aggregates workspace and family spend from usage events", async () => {
    const workspace = await repo.ensureWorkspace(`budget-${randomUUID()}`, process.cwd());
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
        family_key: "family-budget",
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
      cost_usd: 0.25,
      estimated: false
    });

    await repo.upsertBudgetLimit({
      workspaceId: workspace.id,
      limitUsd: 5
    });
    await repo.upsertBudgetLimit({
      workspaceId: workspace.id,
      contractFamilyKey: "family-budget",
      limitUsd: 1
    });

    const statuses = await repo.listBudgetStatuses();
    assert.equal(statuses.length, 2);

    const workspaceBudget = statuses.find((entry) => entry.scope === "workspace");
    assert.ok(workspaceBudget);
    assert.equal(workspaceBudget.workspace_id, workspace.id);
    assert.equal(workspaceBudget.limit_usd, 5);
    assert.equal(workspaceBudget.spent_usd, 0.25);
    assert.equal(workspaceBudget.remaining_usd, 4.75);

    const familyBudget = statuses.find((entry) => entry.scope === "family");
    assert.ok(familyBudget);
    assert.equal(familyBudget.contract_family_key, "family-budget");
    assert.equal(familyBudget.limit_usd, 1);
    assert.equal(familyBudget.spent_usd, 0.25);
    assert.equal(familyBudget.remaining_usd, 0.75);

    const applicable = await repo.listApplicableBudgetStatuses(workspace.id, "family-budget");
    assert.equal(applicable.length, 2);
    assert.equal(
      applicable.some((entry) => entry.scope === "workspace" && entry.remaining_usd === 4.75),
      true
    );
    assert.equal(
      applicable.some((entry) => entry.scope === "family" && entry.remaining_usd === 0.75),
      true
    );
  });

  test("agent trust tiers return defaults when no overrides exist", async () => {
    const workspace = await repo.ensureWorkspace(`trust-default-${randomUUID()}`, process.cwd());

    const tiers = await repo.listAgentTrustTiers(workspace.id);
    assert.equal(tiers.length, 4);
    assert.equal(
      tiers.some(
        (entry) =>
          entry.workspace_id === workspace.id &&
          entry.agent_profile === "builder" &&
          entry.trust_tier === "standard" &&
          entry.managed_by === "system"
      ),
      true
    );
    assert.equal(
      tiers.some(
        (entry) =>
          entry.workspace_id === workspace.id &&
          entry.agent_profile === "researcher" &&
          entry.trust_tier === "restricted"
      ),
      true
    );
  });

  test("system-managed restricted agents auto-promote after three successful runs", async () => {
    const workspace = await repo.ensureWorkspace(`trust-promote-${randomUUID()}`, process.cwd());

    const first = await repo.recordAgentTrustTierOutcome(workspace.id, "researcher", true);
    const second = await repo.recordAgentTrustTierOutcome(workspace.id, "researcher", true);
    const third = await repo.recordAgentTrustTierOutcome(workspace.id, "researcher", true);

    assert.equal(first.after.trust_tier, "restricted");
    assert.equal(second.after.trust_tier, "restricted");
    assert.equal(third.promoted, true);
    assert.equal(third.after.trust_tier, "standard");
    assert.equal(third.after.successful_runs, 3);
    assert.ok(third.after.promoted_at);
  });

  test("manual trust tier overrides persist and do not auto-promote", async () => {
    const workspace = await repo.ensureWorkspace(`trust-manual-${randomUUID()}`, process.cwd());

    await repo.upsertAgentTrustTier({
      workspaceId: workspace.id,
      agentProfile: "debugger",
      trustTier: "probation",
      managedBy: "manual"
    });

    const outcome = await repo.recordAgentTrustTierOutcome(workspace.id, "debugger", true);
    assert.equal(outcome.promoted, false);
    assert.equal(outcome.after.trust_tier, "probation");
    assert.equal(outcome.after.managed_by, "manual");
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

  test("run checkpoint lifecycle persists state and cleans up", async () => {
    const { run } = await createBasicRun();
    const checkpoint = { step: "planning", updated_by: "runner" };

    const saved = await repo.saveRunCheckpoint(run.id, "progress", checkpoint);
    assert.equal(saved.run_id, run.id);
    assert.equal(saved.checkpoint_key, "progress");

    const loaded = await repo.loadRunCheckpoint(run.id, "progress");
    assert.deepEqual(loaded, checkpoint);

    const updatedCheckpoint = { step: "complete", updated_by: "orchestrator" };
    await repo.saveRunCheckpoint(run.id, "progress", updatedCheckpoint);
    const refreshed = await repo.loadRunCheckpoint(run.id, "progress");
    assert.deepEqual(refreshed, updatedCheckpoint);

    await repo.deleteRunCheckpoint(run.id, "progress");
    const removed = await repo.loadRunCheckpoint(run.id, "progress");
    assert.equal(removed, null);
  });
}
