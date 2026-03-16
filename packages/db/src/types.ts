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
  cancellation_requested_at: string | null;
  heartbeat_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  exit_reason: RunExitReason | null;
  outcome_summary: string | null;
  score: number | null;
  created_at: string;
  updated_at: string;
};

export type DbRunSummary = DbRun & {
  evaluation_outcome: "passed" | "failed" | "hard_failed" | null;
  hard_fail_reason: string | null;
  findings_json: string[] | null;
  contract_family_key: string;
  contract_category: string;
  contract_subcategory: string | null;
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

export type DbArtifact = {
  id: string;
  run_id: string;
  task_id: string;
  artifact_type: string;
  path: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type DbAuditEvent = {
  id: number;
  created_at: string;
  actor: string;
  action: string;
  target: string | null;
  metadata: Record<string, unknown>;
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

export type DbIntegrationKey = "supabase" | "llm_api" | "process" | "http";

export type DbIntegrationConfig = {
  integration_key: DbIntegrationKey;
  config_json: Record<string, unknown>;
  updated_at: string;
};

export type DbResearchReviewStatus = "unreviewed" | "accepted" | "rejected";

export type DbResearchIngestion = {
  run_id: string;
  workspace_id: string;
  task_id: string;
  contract_id: string;
  contract_family_key: string;
  contract_category: string;
  contract_subcategory: string | null;
  run_status: "completed" | "failed";
  evaluation_outcome: "passed" | "failed" | "hard_failed";
  score: number;
  policy_denial_count: number;
  event_count: number;
  source_event_types: string[];
  source_json: Record<string, unknown>;
  experiment_id: string | null;
  ingested_at: string;
};

export type DbResearchExperiment = {
  id: string;
  workspace_id: string;
  contract_family_key: string;
  contract_category: string;
  contract_subcategory: string | null;
  sample_size: number;
  source_digest: string;
  source_run_ids: string[];
  metrics_json: Record<string, unknown>;
  body_markdown: string;
  confidence: number;
  review_status: DbResearchReviewStatus;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DbResearchFinding = {
  id: string;
  experiment_id: string;
  workspace_id: string;
  finding_type: string;
  title: string;
  body_markdown: string;
  confidence: number;
  metadata_json: Record<string, unknown>;
  published_memory_id: string | null;
  created_at: string;
};

export type CreateTaskInput = {
  workspaceId?: string;
  title: string;
  request: string;
  requiresApproval?: boolean;
};

export type CreateAuditEventInput = {
  actor: string;
  action: string;
  target?: string | null;
  metadata?: Record<string, unknown>;
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
  contractFamilyKey?: string;
  memoryType: string;
  title: string;
  summary: string;
  bodyMarkdown: string;
  tags: string[];
  confidence: number;
  reviewStatus: "unreviewed" | "accepted" | "rejected";
};

export type ResearchIngestionCandidate = {
  run_id: string;
  workspace_id: string;
  task_id: string;
  contract_id: string;
  run_status: "completed" | "failed";
  evaluation_outcome: "passed" | "failed" | "hard_failed";
  evaluation_score: number;
  policy_denial_count: number;
  event_count: number;
  source_event_types: string[];
  contract_family_key: string;
  contract_category: string;
  contract_subcategory: string | null;
  source_summary: Record<string, unknown>;
};
