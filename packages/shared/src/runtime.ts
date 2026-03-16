export const TASK_STATUSES = [
  "queued",
  "planning",
  "running",
  "blocked",
  "completed",
  "failed",
  "needs_review",
  "cancelled"
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const CONTRACT_STATUSES = [
  "draft",
  "approved",
  "active",
  "superseded",
  "closed"
] as const;

export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const CONTRACT_CATEGORIES = [
  "general",
  "integration",
  "migration",
  "debug",
  "quality",
  "documentation",
  "operations"
] as const;

export type ContractCategory = (typeof CONTRACT_CATEGORIES)[number];

export const RUN_STATUSES = [
  "created",
  "provisioning",
  "starting",
  "running",
  "evaluating",
  "completed",
  "failed",
  "blocked",
  "cancelled"
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "blocked",
  "cancelled"
] as const;

export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export const RUN_EXIT_REASONS = [
  "success",
  "policy_violation",
  "timeout",
  "runner_crash",
  "stale_runner",
  "evaluation_failed",
  "cancelled",
  "unknown"
] as const;

export type RunExitReason = (typeof RUN_EXIT_REASONS)[number];

export const POLICY_DENY_REASONS = [
  "forbidden_path",
  "path_not_allowlisted",
  "command_not_allowlisted",
  "invalid_argument",
  "cwd_not_allowlisted",
  "timeout"
] as const;

export type PolicyDenyReason = (typeof POLICY_DENY_REASONS)[number];

export const AGENT_PROFILES = [
  "builder",
  "researcher",
  "debugger",
  "documenter"
] as const;

export type AgentProfile = (typeof AGENT_PROFILES)[number];

export const AGENT_TRUST_TIERS = [
  "unrestricted",
  "standard",
  "restricted",
  "probation"
] as const;

export type AgentTrustTier = (typeof AGENT_TRUST_TIERS)[number];

export type AgentTrustTierPolicy = {
  requiresApproval: boolean;
  maxRuntimeMinutes: number;
  maxToolCalls: number;
  networkAccess: boolean;
  installPackages: boolean;
  runTests: boolean;
  dbWrite: boolean;
};

export const DEFAULT_AGENT_TRUST_TIER_BY_PROFILE: Record<AgentProfile, AgentTrustTier> = {
  builder: "standard",
  researcher: "restricted",
  debugger: "restricted",
  documenter: "restricted"
};

export const AGENT_TRUST_TIER_POLICIES: Record<AgentTrustTier, AgentTrustTierPolicy> = {
  unrestricted: {
    requiresApproval: false,
    maxRuntimeMinutes: 45,
    maxToolCalls: 400,
    networkAccess: true,
    installPackages: true,
    runTests: true,
    dbWrite: true
  },
  standard: {
    requiresApproval: false,
    maxRuntimeMinutes: 25,
    maxToolCalls: 200,
    networkAccess: false,
    installPackages: false,
    runTests: true,
    dbWrite: true
  },
  restricted: {
    requiresApproval: false,
    maxRuntimeMinutes: 18,
    maxToolCalls: 90,
    networkAccess: false,
    installPackages: false,
    runTests: true,
    dbWrite: false
  },
  probation: {
    requiresApproval: true,
    maxRuntimeMinutes: 10,
    maxToolCalls: 40,
    networkAccess: false,
    installPackages: false,
    runTests: true,
    dbWrite: false
  }
};

export const RETRY_DISPOSITIONS = [
  "not_needed",
  "scheduled",
  "exhausted"
] as const;

export type RetryDisposition = (typeof RETRY_DISPOSITIONS)[number];

export const EVALUATION_OUTCOMES = ["passed", "failed", "hard_failed"] as const;

export type EvaluationOutcome = (typeof EVALUATION_OUTCOMES)[number];

export const RUN_EVENT_TYPES = [
  "run.started",
  "run.heartbeat",
  "plan.generated",
  "tool.called",
  "tool.result",
  "usage.reported",
  "policy.denied",
  "artifact.created",
  "roadblock.detected",
  "run.cancel_requested",
  "evaluation.completed",
  "run.retry_requested",
  "run.final_payload",
  "run.completed",
  "run.cancelled",
  "run.failed"
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export const RUN_EVENT_LEVELS = ["debug", "info", "warn", "error"] as const;

export type RunEventLevel = (typeof RUN_EVENT_LEVELS)[number];

export type TaskId = string;
export type ContractId = string;
export type RunId = string;
export type WorkspaceId = string;

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["planning", "cancelled"],
  planning: ["running", "blocked", "failed", "cancelled", "needs_review"],
  running: ["completed", "blocked", "failed", "needs_review", "cancelled"],
  blocked: ["queued", "running", "failed", "needs_review", "cancelled"],
  completed: [],
  failed: ["queued", "cancelled"],
  needs_review: ["queued", "running", "completed", "failed", "cancelled"],
  cancelled: ["queued"]
};

const CONTRACT_TRANSITIONS: Record<ContractStatus, readonly ContractStatus[]> = {
  draft: ["approved", "superseded", "closed"],
  approved: ["active", "superseded", "closed"],
  active: ["superseded", "closed"],
  superseded: [],
  closed: []
};

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  created: ["provisioning", "starting", "cancelled", "failed"],
  provisioning: ["starting", "failed", "cancelled", "blocked"],
  starting: ["running", "failed", "cancelled", "blocked"],
  running: ["evaluating", "failed", "blocked", "cancelled", "completed"],
  evaluating: ["completed", "failed", "blocked"],
  completed: [],
  failed: [],
  blocked: [],
  cancelled: []
};

function assertTransition<T extends string>(
  current: T,
  next: T,
  allowedMap: Record<T, readonly T[]>,
  stateName: string
): void {
  if (current === next) {
    return;
  }

  const allowed = allowedMap[current] ?? [];
  if (!allowed.includes(next)) {
    throw new Error(`Invalid ${stateName} transition: ${current} -> ${next}`);
  }
}

export function assertTaskTransition(current: TaskStatus, next: TaskStatus): void {
  assertTransition(current, next, TASK_TRANSITIONS, "task");
}

export function assertContractTransition(
  current: ContractStatus,
  next: ContractStatus
): void {
  assertTransition(current, next, CONTRACT_TRANSITIONS, "contract");
}

export function assertRunTransition(current: RunStatus, next: RunStatus): void {
  assertTransition(current, next, RUN_TRANSITIONS, "run");
}

export function isTerminalRunStatus(status: RunStatus): status is TerminalRunStatus {
  return TERMINAL_RUN_STATUSES.includes(status as TerminalRunStatus);
}
