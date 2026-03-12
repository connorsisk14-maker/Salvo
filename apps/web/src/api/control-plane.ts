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
};

const baseUrl = import.meta.env.VITE_SALVO_API_URL ?? "http://localhost:8787";
export const controlPlaneBaseUrl = baseUrl;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new Error(`API request failed (${response.status}) ${path}`);
  }

  return (await response.json()) as T;
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

export function forceRestartDaemon(
  target: ApiRestartTarget
): Promise<ApiRestartResponse> {
  return request<ApiRestartResponse>("/control/restart", {
    method: "POST",
    body: JSON.stringify({ target })
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
