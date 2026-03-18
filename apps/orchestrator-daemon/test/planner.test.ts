import assert from "node:assert/strict";
import test from "node:test";
import type {
  CreateAuditEventInput,
  CreateContractInput,
  CreateTaskInput,
  DbAuditEvent,
  DbContract,
  DbContractMemoryPrompt,
  DbIntegrationConfig,
  DbRunSummary,
  DbTask,
  DbWorkspace
} from "@salvo/db";
import {
  resolvePlannerHour,
  runEveningPlannerCycle,
  shouldRunEveningPlanner
} from "../src/planner";

type PlannerRepo = Parameters<typeof runEveningPlannerCycle>[0]["repo"];

function uuidFromNumber(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function buildWorkspace(overrides?: Partial<DbWorkspace>): DbWorkspace {
  return {
    id: uuidFromNumber(1),
    name: "default",
    local_path: process.cwd(),
    description: null,
    created_at: new Date(2026, 2, 1, 9, 0, 0).toISOString(),
    ...overrides
  };
}

function buildTask(overrides?: Partial<DbTask>): DbTask {
  return {
    id: uuidFromNumber(101),
    workspace_id: uuidFromNumber(1),
    title: "Task title",
    original_request: "Task request",
    normalized_request: "Task request",
    status: "completed",
    requires_approval: false,
    approved_at: null,
    cancelled_at: null,
    claimed_by: null,
    claimed_at: null,
    preferred_agent_profile: null,
    dependency_block_reason: null,
    dependency_blocked_at: null,
    created_at: new Date(2026, 2, 16, 9, 0, 0).toISOString(),
    updated_at: new Date(2026, 2, 16, 9, 0, 0).toISOString(),
    ...overrides
  };
}

function buildRunSummary(overrides?: Partial<DbRunSummary>): DbRunSummary {
  return {
    id: uuidFromNumber(201),
    task_id: uuidFromNumber(101),
    contract_id: uuidFromNumber(301),
    attempt_no: 1,
    agent_profile: "builder",
    status: "completed",
    worker_id: "orchestrator-test",
    runner_pid: null,
    cancellation_requested_at: null,
    heartbeat_at: null,
    started_at: new Date(2026, 2, 16, 9, 10, 0).toISOString(),
    ended_at: new Date(2026, 2, 16, 9, 20, 0).toISOString(),
    exit_reason: "success",
    outcome_summary: "ok",
    score: 95,
    created_at: new Date(2026, 2, 16, 9, 10, 0).toISOString(),
    updated_at: new Date(2026, 2, 16, 9, 20, 0).toISOString(),
    evaluation_outcome: "passed",
    hard_fail_reason: null,
    findings_json: [],
    contract_family_key: "family_ops",
    contract_category: "ops",
    contract_subcategory: null,
    lead_chain_scraper_run_id: null,
    lead_chain_strategist_task_id: null,
    lead_chain_strategist_run_id: null,
    lead_chain_row_context: null,
    ...overrides
  };
}

function createPlannerRepoFixture(input: {
  workspaces: DbWorkspace[];
  tasks: DbTask[];
  runs: DbRunSummary[];
  integrationConfigs?: DbIntegrationConfig[];
  memories?: Record<string, DbContractMemoryPrompt[]>;
}): {
  repo: PlannerRepo;
  taskInputs: CreateTaskInput[];
  createdTasks: DbTask[];
  contractInputs: CreateContractInput[];
  createdContracts: DbContract[];
  auditInputs: CreateAuditEventInput[];
  createdAuditEvents: DbAuditEvent[];
} {
  const storedTasks = [...input.tasks];
  const taskInputs: CreateTaskInput[] = [];
  const createdTasks: DbTask[] = [];
  const contractInputs: CreateContractInput[] = [];
  const createdContracts: DbContract[] = [];
  const auditInputs: CreateAuditEventInput[] = [];
  const createdAuditEvents: DbAuditEvent[] = [];
  const integrationConfigs = input.integrationConfigs ?? [];
  const memories = input.memories ?? {};

  const repo: PlannerRepo = {
    async listWorkspaces() {
      return input.workspaces;
    },
    async listTasks() {
      return storedTasks;
    },
    async listRunSummaries() {
      return input.runs;
    },
    async listResearchContext() {
      return [];
    },
    async listRelevantMemoryPromptContext(workspaceId, _queryText, contractFamilyKey) {
      return memories[`${workspaceId}:${contractFamilyKey ?? "general"}`] ?? [];
    },
    async listIntegrationConfigs() {
      return integrationConfigs;
    },
    async createTask(taskInput) {
      taskInputs.push(taskInput);
      const id = uuidFromNumber(400 + createdTasks.length + 1);
      const now = new Date(2026, 2, 16, 22, 0, createdTasks.length).toISOString();
      const task = buildTask({
        id,
        workspace_id: taskInput.workspaceId ?? uuidFromNumber(1),
        title: taskInput.title,
        original_request: taskInput.request,
        normalized_request: taskInput.request.replace(/\s+/g, " ").trim(),
        status: "queued",
        requires_approval: taskInput.requiresApproval ?? false,
        created_at: now,
        updated_at: now
      });
      storedTasks.unshift(task);
      createdTasks.push(task);
      return task;
    },
    async createContract(contractInput) {
      contractInputs.push(contractInput);
      const now = new Date(2026, 2, 16, 22, 10, createdContracts.length).toISOString();
      const contract: DbContract = {
        id: uuidFromNumber(500 + createdContracts.length + 1),
        task_id: contractInput.taskId,
        version: 1,
        status: contractInput.status,
        risk: contractInput.risk,
        contract_json: contractInput.contractJson,
        created_at: now,
        updated_at: now
      };
      createdContracts.push(contract);
      return contract;
    },
    async createAuditEvent(auditInput) {
      auditInputs.push(auditInput);
      const event: DbAuditEvent = {
        id: createdAuditEvents.length + 1,
        created_at: new Date(2026, 2, 16, 22, 30, createdAuditEvents.length).toISOString(),
        actor: auditInput.actor,
        action: auditInput.action,
        target: auditInput.target ?? null,
        metadata: auditInput.metadata ?? {}
      };
      createdAuditEvents.push(event);
      return event;
    }
  };

  return {
    repo,
    taskInputs,
    createdTasks,
    contractInputs,
    createdContracts,
    auditInputs,
    createdAuditEvents
  };
}

test("resolvePlannerHour and shouldRunEveningPlanner enforce evening schedule and per-day guard", () => {
  assert.equal(resolvePlannerHour(undefined), 22);
  assert.equal(resolvePlannerHour("6.8"), 6);
  assert.equal(resolvePlannerHour("-2"), 0);
  assert.equal(resolvePlannerHour("25"), 23);
  assert.equal(resolvePlannerHour("not-a-number"), 22);

  const morning = new Date(2026, 2, 16, 21, 59, 0);
  const evening = new Date(2026, 2, 16, 22, 0, 0);
  const tomorrow = new Date(2026, 2, 17, 22, 0, 0);

  assert.equal(
    shouldRunEveningPlanner({
      now: morning,
      plannerHour: 22
    }),
    false
  );

  assert.equal(
    shouldRunEveningPlanner({
      now: evening,
      plannerHour: 22
    }),
    true
  );

  assert.equal(
    shouldRunEveningPlanner({
      now: evening,
      plannerHour: 22,
      lastPlannedDateKey: "2026-03-16"
    }),
    false
  );

  assert.equal(
    shouldRunEveningPlanner({
      now: tomorrow,
      plannerHour: 22,
      lastPlannedDateKey: "2026-03-16"
    }),
    true
  );
});

test("runEveningPlannerCycle creates planner drafts once per day and emits planning audits", async () => {
  const workspace = buildWorkspace({
    id: uuidFromNumber(2)
  });
  const task1 = buildTask({
    id: uuidFromNumber(102),
    workspace_id: workspace.id,
    title: "Fix flaky planner retries"
  });
  const task2 = buildTask({
    id: uuidFromNumber(103),
    workspace_id: workspace.id,
    title: "Stabilize build script"
  });
  const runs = [
    buildRunSummary({
      id: uuidFromNumber(202),
      task_id: task1.id,
      contract_family_key: "family_ops",
      created_at: new Date(2026, 2, 16, 8, 30, 0).toISOString()
    }),
    buildRunSummary({
      id: uuidFromNumber(203),
      task_id: task2.id,
      contract_family_key: "family_ops",
      created_at: new Date(2026, 2, 16, 10, 30, 0).toISOString()
    }),
    buildRunSummary({
      id: uuidFromNumber(204),
      task_id: task2.id,
      contract_family_key: "family_quality",
      created_at: new Date(2026, 2, 16, 12, 45, 0).toISOString()
    }),
    buildRunSummary({
      id: uuidFromNumber(205),
      task_id: task1.id,
      contract_family_key: "family_ignore",
      created_at: new Date(2026, 2, 15, 12, 45, 0).toISOString()
    })
  ];

  const fixture = createPlannerRepoFixture({
    workspaces: [workspace],
    tasks: [task1, task2],
    runs
  });

  const now = new Date(2026, 2, 16, 22, 5, 0);
  const first = await runEveningPlannerCycle({
    repo: fixture.repo,
    workerId: "orchestrator-test",
    now,
    plannerHour: 22,
    env: {},
    maxDraftsPerWorkspace: 2
  });

  assert.equal(first.dateKey, "2026-03-16");
  assert.equal(first.targetDateKey, "2026-03-17");
  assert.equal(first.workspaceCount, 1);
  assert.equal(first.createdDraftCount, 2);
  assert.equal(first.skippedDuplicateCount, 0);
  assert.deepEqual(
    fixture.createdTasks.map((task) => task.title),
    ["[Planner 2026-03-17] family_ops", "[Planner 2026-03-17] family_quality"]
  );
  assert.equal(fixture.taskInputs.every((taskInput) => taskInput.requiresApproval === true), true);
  assert.equal(
    fixture.contractInputs.every((contractInput) => contractInput.status === "draft"),
    true
  );
  assert.equal(
    fixture.auditInputs.filter((event) => event.action === "planning.llm_fallback").length,
    2
  );
  assert.equal(
    fixture.auditInputs.filter((event) => event.action === "planning.completed").length,
    1
  );

  const second = await runEveningPlannerCycle({
    repo: fixture.repo,
    workerId: "orchestrator-test",
    now,
    plannerHour: 22,
    env: {},
    maxDraftsPerWorkspace: 2
  });

  assert.equal(second.createdDraftCount, 0);
  assert.equal(second.skippedDuplicateCount, 2);
  assert.equal(fixture.createdTasks.length, 2);
  assert.equal(
    fixture.auditInputs.filter((event) => event.action === "planning.llm_fallback").length,
    2
  );
  assert.equal(
    fixture.auditInputs.filter((event) => event.action === "planning.completed").length,
    2
  );
});

test("runEveningPlannerCycle falls back to general family when there is no run history", async () => {
  const workspace = buildWorkspace({
    id: uuidFromNumber(3)
  });
  const fixture = createPlannerRepoFixture({
    workspaces: [workspace],
    tasks: [],
    runs: []
  });

  const result = await runEveningPlannerCycle({
    repo: fixture.repo,
    workerId: "orchestrator-test",
    now: new Date(2026, 2, 16, 22, 40, 0),
    plannerHour: 22,
    env: {}
  });

  assert.equal(result.createdDraftCount, 1);
  assert.equal(result.skippedDuplicateCount, 0);
  assert.deepEqual(
    fixture.createdTasks.map((task) => task.title),
    ["[Planner 2026-03-17] general"]
  );
  assert.equal(
    fixture.auditInputs.filter((event) => event.action === "planning.llm_fallback").length,
    1
  );
  assert.equal(
    fixture.auditInputs.filter((event) => event.action === "planning.completed").length,
    1
  );
});
