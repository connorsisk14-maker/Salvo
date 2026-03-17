import { randomUUID } from "node:crypto";
import type { DbContractMemoryPrompt, DbRunSummary, DbTask, SalvoRepository } from "@salvo/db";
import {
  buildHeuristicContract,
  collectWorkspaceSnapshot,
  planContract,
  resolveContractPlannerConfig
} from "./contract-planner";

const DEFAULT_PLANNER_HOUR = 22;
const DEFAULT_MAX_DRAFTS_PER_WORKSPACE = 3;
const PLANNER_TITLE_PREFIX = "[Planner";
const PLANNER_TASK_SCAN_LIMIT = 5_000;
const PLANNER_RUN_SCAN_LIMIT = 1_000;

export type PlannerScheduleInput = {
  now: Date;
  plannerHour: number;
  lastPlannedDateKey?: string;
};

export type PlannerCycleResult = {
  dateKey: string;
  targetDateKey: string;
  workspaceCount: number;
  createdDraftCount: number;
  skippedDuplicateCount: number;
  createdTaskIds: string[];
  createdContractIds: string[];
};

type PlannerRepo = Pick<
  SalvoRepository,
  | "listWorkspaces"
  | "listTasks"
  | "listRunSummaries"
  | "listResearchContext"
  | "listContractMemoryPromptContext"
  | "listIntegrationConfigs"
  | "createTask"
  | "createContract"
  | "createAuditEvent"
>;

export type RunEveningPlannerCycleInput = {
  repo: PlannerRepo;
  workerId: string;
  now: Date;
  plannerHour: number;
  env: NodeJS.ProcessEnv;
  maxDraftsPerWorkspace?: number;
};

function clampPlannerHour(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_PLANNER_HOUR;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 23) {
    return 23;
  }
  return Math.floor(value);
}

function localDatePart(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function toLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${localDatePart(date.getMonth() + 1)}-${localDatePart(date.getDate())}`;
}

export function nextDayKey(date: Date): string {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + 1);
  return toLocalDateKey(next);
}

export function resolvePlannerHour(envValue: string | undefined): number {
  return clampPlannerHour(Number(envValue ?? DEFAULT_PLANNER_HOUR));
}

export function shouldRunEveningPlanner(input: PlannerScheduleInput): boolean {
  const dateKey = toLocalDateKey(input.now);
  if (input.lastPlannedDateKey === dateKey) {
    return false;
  }
  return input.now.getHours() >= input.plannerHour;
}

function plannerTitle(targetDateKey: string, familyKey: string): string {
  return `${PLANNER_TITLE_PREFIX} ${targetDateKey}] ${familyKey}`;
}

function dedupeAndSortFamilyKeys(runSummaries: DbRunSummary[]): string[] {
  const counts = new Map<string, number>();
  for (const run of runSummaries) {
    const key = run.contract_family_key?.trim() || "general";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([familyKey]) => familyKey);
}

function workspaceRunsForDay(input: {
  runs: DbRunSummary[];
  tasksById: Map<string, DbTask>;
  workspaceId: string;
  dateKey: string;
}): DbRunSummary[] {
  return input.runs.filter((run) => {
    const task = input.tasksById.get(run.task_id);
    if (!task || task.workspace_id !== input.workspaceId) {
      return false;
    }

    return toLocalDateKey(new Date(run.created_at)) === input.dateKey;
  });
}

function recentRunHistoryByFamily(runs: DbRunSummary[], familyKey: string): Array<{ runId: string }> {
  const history = familyKey === "general"
    ? runs
    : runs.filter((run) => run.contract_family_key === familyKey);
  return history.slice(0, 8).map((run) => ({ runId: run.id }));
}

export async function runEveningPlannerCycle(input: RunEveningPlannerCycleInput): Promise<PlannerCycleResult> {
  const dateKey = toLocalDateKey(input.now);
  const targetDateKey = nextDayKey(input.now);
  const maxDraftsPerWorkspace = input.maxDraftsPerWorkspace ?? DEFAULT_MAX_DRAFTS_PER_WORKSPACE;

  const [workspaces, tasks, runs, integrationConfigs] = await Promise.all([
    input.repo.listWorkspaces(),
    input.repo.listTasks(PLANNER_TASK_SCAN_LIMIT),
    input.repo.listRunSummaries(PLANNER_RUN_SCAN_LIMIT),
    input.repo.listIntegrationConfigs()
  ]);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const createdTaskIds: string[] = [];
  const createdContractIds: string[] = [];
  let skippedDuplicateCount = 0;

  for (const workspace of workspaces) {
    const todayRuns = workspaceRunsForDay({
      runs,
      tasksById,
      workspaceId: workspace.id,
      dateKey
    });
    const researchContext = await input.repo.listResearchContext(workspace.id, 8);
    const familyKeys = dedupeAndSortFamilyKeys(todayRuns);

    if (familyKeys.length === 0) {
      familyKeys.push("general");
    }

    const workspaceEntries = await collectWorkspaceSnapshot(workspace.local_path);
    const existingTitles = new Set(
      tasks
        .filter((task) => task.workspace_id === workspace.id)
        .map((task) => task.title)
    );

    for (const familyKey of familyKeys.slice(0, maxDraftsPerWorkspace)) {
      const title = plannerTitle(targetDateKey, familyKey);
      if (existingTitles.has(title)) {
        skippedDuplicateCount += 1;
        continue;
      }

      const request = [
        `Generate a next-day draft contract for ${targetDateKey}.`,
        `Primary family focus: ${familyKey}.`,
        "Bias for tight scope and high-confidence deliverables."
      ].join(" ");

      const task = await input.repo.createTask({
        workspaceId: workspace.id,
        title,
        request,
        requiresApproval: true
      });

      const heuristicContract = buildHeuristicContract({
        contractId: randomUUID(),
        taskId: task.id,
        workspaceId: workspace.id,
        request,
        taskTitle: title
      });

      const memories: DbContractMemoryPrompt[] = familyKey === "general"
        ? []
        : await input.repo.listContractMemoryPromptContext(workspace.id, familyKey, 5);

      const planned = await planContract({
        task,
        workspace,
        baseContract: heuristicContract,
        workspaceEntries,
        memories,
        recentRunHistory: recentRunHistoryByFamily(todayRuns, familyKey),
        activeResearchFindings: researchContext.map((entry) => ({
          id: entry.id,
          confidence: entry.confidence
        })),
        llmConfig: resolveContractPlannerConfig({
          integrationConfigs,
          env: input.env
        })
      });

      const contract = await input.repo.createContract({
        taskId: task.id,
        risk: planned.contract.risk,
        status: "draft",
        contractJson: planned.contract
      });

      createdTaskIds.push(task.id);
      createdContractIds.push(contract.id);
      existingTitles.add(title);

      if (planned.source === "fallback") {
        await input.repo.createAuditEvent({
          actor: `system:${input.workerId}`,
          action: "planning.llm_fallback",
          target: task.id,
          metadata: {
            workspace_id: workspace.id,
            family_key: familyKey,
            reason: planned.reason ?? "unknown"
          }
        });
      }
    }
  }

  await input.repo.createAuditEvent({
    actor: `system:${input.workerId}`,
    action: "planning.completed",
    metadata: {
      planning_date: dateKey,
      target_date: targetDateKey,
      planner_hour: input.plannerHour,
      workspace_count: workspaces.length,
      created_draft_count: createdContractIds.length,
      skipped_duplicate_count: skippedDuplicateCount,
      created_task_ids: createdTaskIds,
      created_contract_ids: createdContractIds
    }
  });

  return {
    dateKey,
    targetDateKey,
    workspaceCount: workspaces.length,
    createdDraftCount: createdContractIds.length,
    skippedDuplicateCount,
    createdTaskIds,
    createdContractIds
  };
}
