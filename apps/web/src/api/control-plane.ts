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
  score: number | null;
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
