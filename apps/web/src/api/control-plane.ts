import { clearStoredApiToken, getStoredApiToken } from "./auth";

export type ApiTask = {
  id: string;
  title: string;
  original_request: string;
  status: string;
  requires_approval: boolean;
  approved_at: string | null;
  created_at: string;
};

export type ApiRun = {
  id: string;
  task_id: string;
  contract_id: string;
  status: string;
  attempt_no: number;
  exit_reason?: string | null;
  outcome_summary?: string | null;
  score: number | null;
  evaluation_outcome?: "passed" | "failed" | "hard_failed" | null;
  hard_fail_reason?: string | null;
  findings_json?: string[] | null;
  contract_family_key: string;
  contract_category: string;
  contract_subcategory: string | null;
  created_at: string;
};

export type ApiRunEvent = {
  id: number;
  run_id: string;
  sequence_no: number;
  event_type: string;
  level: string;
  payload_json: Record<string, unknown>;
  created_at: string;
};

export type ApiDaemonHealth = {
  status: "healthy" | "stale" | "offline";
  daemon_id?: string;
  heartbeat_at?: string;
  age_seconds?: number;
  threshold_seconds: number;
  metadata?: Record<string, unknown>;
};

export type ApiRestartTarget = "orchestrator" | "research" | "all";

export type ApiRestartResponse = {
  ok: boolean;
  results: Array<{
    daemon: "orchestrator" | "research";
    killed: boolean;
    started: boolean;
    pid?: number;
    note: string;
  }>;
};

export type ApiActionResponse = {
  ok: boolean;
  error?: string;
};

export type ApiBackupFileRecord = {
  file_name: string;
  path: string;
  created_at: string;
  size_bytes: number;
  verified_at: string;
};

export type ApiBackupRunRecord = {
  trigger: "scheduled" | "manual";
  started_at: string;
  completed_at: string;
  success: boolean;
  error: string | null;
  backup: ApiBackupFileRecord | null;
};

export type ApiBackupStatus = {
  state: "pending" | "running" | "healthy" | "stale" | "error";
  storage_dir: string;
  schedule_hour_local: number;
  next_scheduled_at: string;
  retention: {
    daily: number;
    weekly: number;
  };
  running: {
    pid: number;
    trigger: "scheduled" | "manual";
    started_at: string;
  } | null;
  last_run: ApiBackupRunRecord | null;
  recent_backups: ApiBackupFileRecord[];
};

export type ApiBackupTriggerResponse = ApiActionResponse & {
  result?: ApiBackupRunRecord;
};

export type ApiResearchDoc = {
  id: string;
  workspace_id: string;
  title: string;
  topic: string;
  confidence: number;
  review_status: "unreviewed" | "accepted" | "rejected";
  source_run_ids: string[];
  created_at: string;
};

export type ApiMemory = {
  id: string;
  workspace_id: string;
  memory_type: string;
  title: string;
  confidence: number;
  review_status: "unreviewed" | "accepted" | "rejected";
  source_run_ids: string[];
  created_at: string;
};

export type ApiResearchExperiment = {
  id: string;
  workspace_id: string;
  contract_family_key: string;
  contract_category: string;
  contract_subcategory: string | null;
  sample_size: number;
  confidence: number;
  review_status: "unreviewed" | "accepted" | "rejected";
  source_run_ids: string[];
  published_at: string | null;
  created_at: string;
  metrics_json: Record<string, unknown>;
  body_markdown: string;
};

export type ApiIntegration = {
  key: string;
  label: string;
  status: "ready" | "not_configured" | "needs_auth" | "error" | "healthy" | "stale" | "offline";
  detail: string;
  updated_at: string;
  editable: boolean;
  config?: Record<string, unknown>;
};

export type ApiCostMetrics = {
  updated_at: string;
  estimated: boolean;
  totals: {
    runs: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
  };
  by_model: Array<{
    model: string;
    runs: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
  }>;
  by_agent_profile: Array<{
    agent_profile: string;
    runs: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
  }>;
};

export type ApiBudgetStatus = {
  id: string;
  workspace_id: string;
  workspace_name: string;
  contract_family_key: string | null;
  scope: "workspace" | "family";
  limit_usd: number;
  spent_usd: number;
  remaining_usd: number;
  last_usage_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ApiBudgetOverview = {
  updated_at: string;
  workspaces: Array<{
    id: string;
    name: string;
  }>;
  budgets: ApiBudgetStatus[];
};

export type ApiTrustTier = {
  workspace_id: string;
  workspace_name: string;
  agent_profile: string;
  trust_tier: "unrestricted" | "standard" | "restricted" | "probation";
  successful_runs: number;
  last_run_at: string | null;
  promoted_at: string | null;
  managed_by: "system" | "manual";
  created_at: string | null;
  updated_at: string | null;
};

export type ApiTrustTierOverview = {
  updated_at: string;
  workspaces: Array<{
    id: string;
    name: string;
  }>;
  tiers: ApiTrustTier[];
};

export type ApiRunDetail = {
  run: ApiRun;
  task: ApiTask;
  contract: {
    id: string;
    status: string;
    risk: string;
    contract_json: Record<string, unknown>;
  };
  evaluation: {
    passed: boolean;
    score: number;
    outcome: string;
    hard_fail_reason: string | null;
    findings_json: string[];
  } | null;
  research: Array<{
    id: string;
    title: string;
    confidence: number;
    review_status: string;
    created_at: string;
  }>;
  artifacts: Array<{
    id: string;
    artifact_type: string;
    path: string;
    metadata_json: Record<string, unknown>;
    created_at: string;
  }>;
  final_payload: Record<string, unknown> | null;
};

export type ApiArtifactPreview =
  | {
      id: string;
      kind: "image";
      mime_type: string;
      content_url: string;
    }
  | {
      id: string;
      kind: "text";
      mime_type: string;
      content: string;
      truncated: boolean;
    }
  | {
      id: string;
      kind: "binary";
      mime_type: string;
      content_url: string;
    };

const baseUrl = import.meta.env.VITE_SALVO_API_URL ?? "http://localhost:8787";
export const controlPlaneBaseUrl = baseUrl;

function buildHeaders(init: RequestInit | undefined): Headers {
  const headers = new Headers(init?.headers ?? {});
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const token = getStoredApiToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  return headers;
}

async function readErrorMessage(response: Response, path: string): Promise<string> {
  const fallback = `API request failed (${response.status}) ${path}`;

  try {
    const payload = (await response.clone().json()) as {
      error?: string;
      issues?: Array<{ path?: string; message?: string }>;
    };

    if (Array.isArray(payload.issues) && payload.issues.length > 0) {
      const issueSummary = payload.issues
        .map((issue) => `${issue.path ?? "body"}: ${issue.message ?? "invalid value"}`)
        .join("; ");
      return payload.error ? `${payload.error} ${issueSummary}` : issueSummary;
    }

    if (typeof payload.error === "string" && payload.error.length > 0) {
      return payload.error;
    }
  } catch {
    const text = await response.text();
    if (text.trim().length > 0) {
      return text.trim();
    }
  }

  return fallback;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: buildHeaders(init)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, path);
    if (response.status === 401) {
      clearStoredApiToken();
      throw new Error(`API authorization failed. ${message}`);
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

async function requestBlob(path: string, init?: RequestInit): Promise<Blob> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: buildHeaders(init)
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, path);
    if (response.status === 401) {
      clearStoredApiToken();
      throw new Error(`API authorization failed. ${message}`);
    }
    throw new Error(message);
  }

  return response.blob();
}

export function createTask(input: {
  title: string;
  request: string;
  requiresApproval: boolean;
}): Promise<ApiTask> {
  return request<ApiTask>("/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      request: input.request,
      requiresApproval: input.requiresApproval
    })
  });
}

export function listTasks(): Promise<ApiTask[]> {
  return request<ApiTask[]>("/tasks");
}

export function approveTask(taskId: string): Promise<ApiTask> {
  return request<ApiTask>(`/tasks/${taskId}/approve`, {
    method: "POST"
  });
}

export function rejectTask(taskId: string): Promise<ApiTask> {
  return request<ApiTask>(`/tasks/${taskId}/reject`, {
    method: "POST"
  });
}

export function cancelTask(taskId: string): Promise<ApiTask> {
  return request<ApiTask>(`/tasks/${taskId}/cancel`, {
    method: "POST"
  });
}

export function listRuns(): Promise<ApiRun[]> {
  return request<ApiRun[]>("/runs");
}

export function getRunDetail(runId: string): Promise<ApiRunDetail> {
  return request<ApiRunDetail>(`/runs/${runId}`);
}

export function getRunEvents(runId: string): Promise<ApiRunEvent[]> {
  return request<ApiRunEvent[]>(`/runs/${runId}/events`);
}

export function getOrchestratorHealth(): Promise<ApiDaemonHealth> {
  return request<ApiDaemonHealth>("/health/orchestrator");
}

export function getResearchHealth(): Promise<ApiDaemonHealth> {
  return request<ApiDaemonHealth>("/health/research");
}

export function getBackupStatus(): Promise<ApiBackupStatus> {
  return request<ApiBackupStatus>("/backups/status");
}

export function listIntegrations(): Promise<ApiIntegration[]> {
  return request<ApiIntegration[]>("/integrations");
}

export function getCostMetrics(): Promise<ApiCostMetrics> {
  return request<ApiCostMetrics>("/metrics/costs");
}

export function getBudgetOverview(): Promise<ApiBudgetOverview> {
  return request<ApiBudgetOverview>("/budgets");
}

export function saveBudgetLimit(input: {
  workspaceId: string;
  contractFamilyKey?: string;
  limitUsd: number;
}): Promise<ApiActionResponse & { budget?: ApiBudgetStatus }> {
  return request<ApiActionResponse & { budget?: ApiBudgetStatus }>("/budgets", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function getTrustTierOverview(): Promise<ApiTrustTierOverview> {
  return request<ApiTrustTierOverview>("/trust-tiers");
}

export function saveTrustTier(input: {
  workspaceId: string;
  agentProfile: string;
  trustTier: ApiTrustTier["trust_tier"];
}): Promise<ApiActionResponse & { tier?: ApiTrustTier }> {
  return request<ApiActionResponse & { tier?: ApiTrustTier }>("/trust-tiers", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateIntegrationConfig(
  key: "supabase" | "llm_api" | "process" | "http",
  input: Record<string, unknown>
): Promise<ApiActionResponse> {
  return request<ApiActionResponse>(`/integrations/${key}/config`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function forceRestartDaemon(
  target: ApiRestartTarget
): Promise<ApiRestartResponse> {
  return request<ApiRestartResponse>("/control/restart", {
    method: "POST",
    body: JSON.stringify({ target })
  });
}

export function triggerBackup(): Promise<ApiBackupTriggerResponse> {
  return request<ApiBackupTriggerResponse>("/control/backup", {
    method: "POST"
  });
}

export function retryRun(runId: string): Promise<ApiActionResponse> {
  return request<ApiActionResponse>(`/runs/${runId}/retry`, {
    method: "POST"
  });
}

export function cancelRun(runId: string): Promise<ApiActionResponse> {
  return request<ApiActionResponse>(`/runs/${runId}/cancel`, {
    method: "POST"
  });
}

export function listResearch(
  status?: "unreviewed" | "accepted" | "rejected"
): Promise<ApiResearchDoc[]> {
  const query = status ? `?status=${status}` : "";
  return request<ApiResearchDoc[]>(`/research${query}`);
}

export function reviewResearch(
  id: string,
  status: "unreviewed" | "accepted" | "rejected"
): Promise<ApiActionResponse> {
  return request<ApiActionResponse>(`/research/${id}/review`, {
    method: "POST",
    body: JSON.stringify({ status })
  });
}

export function listResearchExperiments(
  status?: "unreviewed" | "accepted" | "rejected"
): Promise<ApiResearchExperiment[]> {
  const query = status ? `?status=${status}` : "";
  return request<ApiResearchExperiment[]>(`/research/experiments${query}`);
}

export function reviewResearchExperiment(
  id: string,
  status: "unreviewed" | "accepted" | "rejected"
): Promise<ApiActionResponse> {
  return request<ApiActionResponse>(`/research/experiments/${id}/review`, {
    method: "POST",
    body: JSON.stringify({ status })
  });
}

export function listMemories(
  status?: "unreviewed" | "accepted" | "rejected"
): Promise<ApiMemory[]> {
  const query = status ? `?status=${status}` : "";
  return request<ApiMemory[]>(`/memories${query}`);
}

export function reviewMemory(
  id: string,
  status: "unreviewed" | "accepted" | "rejected"
): Promise<ApiActionResponse> {
  return request<ApiActionResponse>(`/memories/${id}/review`, {
    method: "POST",
    body: JSON.stringify({ status })
  });
}

export function streamUrl(path: string): string {
  return `${baseUrl}${path}`;
}

export function getArtifactPreview(artifactId: string): Promise<ApiArtifactPreview> {
  return request<ApiArtifactPreview>(`/artifacts/${artifactId}/preview`);
}

export function artifactContentUrl(artifactId: string): string {
  return `${baseUrl}/artifacts/${artifactId}/content`;
}

export async function getArtifactContentObjectUrl(artifactId: string): Promise<string> {
  const blob = await requestBlob(`/artifacts/${artifactId}/content`);
  return URL.createObjectURL(blob);
}

export async function openArtifactContent(artifactId: string): Promise<void> {
  const objectUrl = await getArtifactContentObjectUrl(artifactId);
  const opened = window.open(objectUrl, "_blank", "noopener,noreferrer");
  if (!opened) {
    URL.revokeObjectURL(objectUrl);
    throw new Error("Unable to open artifact file. Check popup permissions.");
  }

  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 60_000);
}
