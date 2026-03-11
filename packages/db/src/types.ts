import type {
  AgentProfile,
  ContractStatus,
  RunExitReason,
  RunEventLevel,
  RunEventType,
  RunStatus,
  TaskStatus
} from "@salvo/shared";

export type DbWorkspace = {
  id: string;
  name: string;
  local_path: string;
  description: string | null;
  created_at: string;
};

export type DbTask = {
  id: string;
  workspace_id: string;
  title: string;
  original_request: string;
  normalized_request: string;
  status: TaskStatus;
  requires_approval: boolean;
  approved_at: string | null;
  cancelled_at: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DbContract = {
  id: string;
  task_id: string;
  version: number;
  status: ContractStatus;
  risk: "low" | "medium" | "high";
  contract_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type DbRun = {
  id: string;
  task_id: string;
  contract_id: string;
  attempt_no: number;
  agent_profile: AgentProfile;
  status: RunStatus;
  worker_id: string | null;
  runner_pid: number | null;
  heartbeat_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  exit_reason: RunExitReason | null;
  outcome_summary: string | null;
  score: number | null;
  synthesized_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DbRunEvent = {
  id: number;
  run_id: string;
  sequence_no: number;
  event_type: RunEventType;
  level: RunEventLevel;
  payload_json: Record<string, unknown>;
  schema_version: number;
  created_at: string;
};

export type DbEvaluation = {
  id: string;
  run_id: string;
  contract_id: string;
  passed: boolean;
  score: number;
  outcome: "passed" | "failed" | "hard_failed";
  hard_fail_reason: string | null;
  findings_json: string[];
  created_at: string;
};

export type DaemonType = "orchestrator" | "research";

export type DbDaemonHeartbeat = {
  daemon_type: DaemonType;
  daemon_id: string;
  heartbeat_at: string;
  metadata_json: Record<string, unknown>;
  updated_at: string;
};

export type CreateTaskInput = {
  workspaceId?: string;
  title: string;
  request: string;
  requiresApproval?: boolean;
};

export type CreateContractInput = {
  taskId: string;
  risk: "low" | "medium" | "high";
  status: ContractStatus;
  contractJson: Record<string, unknown>;
};

export type CreateRunInput = {
  taskId: string;
  contractId: string;
  agentProfile: AgentProfile;
  workerId: string;
};

export type RecordEvaluationInput = {
  runId: string;
  contractId: string;
  passed: boolean;
  score: number;
  outcome: "passed" | "failed" | "hard_failed";
  hardFailReason?: string;
  findings: string[];
};

export type CreateResearchInput = {
  workspaceId: string;
  title: string;
  topic: string;
  bodyMarkdown: string;
  sourceRunIds: string[];
  confidence: number;
  reviewStatus: "unreviewed" | "accepted" | "rejected";
};

export type CreateMemoryInput = {
  workspaceId: string;
  sourceRunIds: string[];
  memoryType: string;
  title: string;
  summary: string;
  bodyMarkdown: string;
  tags: string[];
  confidence: number;
  reviewStatus: "unreviewed" | "accepted" | "rejected";
};
