import type {
  AgentProfile,
  AgentTrustTier,
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

export type DbContractMemoryPrompt = {
  id: string;
  title: string;
  summary: string;
  body_markdown: string;
  confidence: number;
  review_status: "unreviewed" | "accepted" | "rejected";
  source_run_ids: string[];
};

export type DbContractMemoryContext = {
  id: string;
  confidence: number;
  review_status: "unreviewed" | "accepted" | "rejected";
  source_run_ids: string[];
  experiment_id: string | null;
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

export type TaskChatSessionStatus = "active" | "approved";

export type TaskChatRole = "user" | "assistant";

export type TaskChatProposal = {
  title: string;
  request: string;
  risk: "low" | "medium" | "high";
  requires_approval: boolean;
  contract_json: Record<string, unknown>;
};

export type DbTaskChatSession = {
  id: string;
  workspace_id: string;
  status: TaskChatSessionStatus;
  pending_proposal_json: Record<string, unknown> | null;
  approved_task_id: string | null;
  approved_contract_id: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DbTaskChatMessage = {
  id: number;
  session_id: string;
  role: TaskChatRole;
  message_text: string;
  proposed_contract_json: Record<string, unknown> | null;
  created_at: string;
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
  lead_chain_scraper_run_id: string | null;
  lead_chain_strategist_task_id: string | null;
  lead_chain_strategist_run_id: string | null;
};

export type DbLeadRunChain = {
  id: string;
  scraper_run_id: string;
  strategist_task_id: string;
  strategist_run_id: string | null;
  row_context: Record<string, unknown> | null;
  created_at: string;
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

export type DbIntegrationKey =
  | "supabase"
  | "llm_api"
  | "process"
  | "http"
  | "google_sheets";

export type DbIntegrationConfig = {
  integration_key: DbIntegrationKey;
  config_json: Record<string, unknown>;
  updated_at: string;
};

export type DbSkillSetting = {
  id: string;
  workspace_id: string;
  skill_name: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type DbSkillUsage = {
  skill_name: string;
  call_count: number;
  success_count: number;
  failure_count: number;
  last_used_at: string | null;
};

export type DbAgentTrustTier = {
  workspace_id: string;
  workspace_name: string;
  agent_profile: AgentProfile;
  trust_tier: AgentTrustTier;
  successful_runs: number;
  last_run_at: string | null;
  promoted_at: string | null;
  managed_by: "system" | "manual";
  created_at: string | null;
  updated_at: string | null;
};

export type DbBudgetLimit = {
  id: string;
  workspace_id: string;
  contract_family_key: string | null;
  limit_usd: number;
  created_at: string;
  updated_at: string;
};

export type DbBudgetStatus = DbBudgetLimit & {
  workspace_name: string;
  scope: "workspace" | "family";
  spent_usd: number;
  remaining_usd: number;
  last_usage_at: string | null;
};

export type DbIdempotencyKey = {
  scope: string;
  idempotency_key: string;
  request_fingerprint: string;
  status: "processing" | "completed";
  response_status: number | null;
  response_json: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
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

export type IdempotentResult<T> = {
  resource: T;
  duplicate: boolean;
  responseStatus: number;
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
  leadChainId?: string;
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

export type AnalyticsCostSummary = {
  totalCostUsd: number;
  runCount: number;
  averageCostUsd: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
};

export type AnalyticsCostDimensionRow = {
  label: string;
  costUsd: number;
  runs: number;
};

export type AnalyticsCostDayRow = {
  date: string;
  costUsd: number;
  runs: number;
};
