import { useEffect, useMemo, useState } from "react";
import {
  approveTask,
  getContract,
  listRuns,
  listTasks,
  rejectTask,
  type ApiContract,
  type ApiRun,
  type ApiTask
} from "../api/control-plane";

const capabilityLabels: Record<string, string> = {
  filesystem_read: "Filesystem read",
  filesystem_write: "Filesystem write",
  run_tests: "Run tests",
  install_packages: "Install packages",
  network_access: "Network access",
  db_read: "Database read",
  db_write: "Database write",
  email_send: "Email sending"
};

function formatDateTime(value?: string | null): string {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString();
}

function ensureArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

type DiffSegment = {
  type: "shared" | "removed" | "added";
  text: string;
};

type ContractObjectiveDocument = Record<string, unknown> & {
  primary?: unknown;
  secondary?: unknown;
  non_goals?: unknown;
};

function splitForDiff(value?: string | null): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/\r?\n/)
    .flatMap((segment) => segment.split(/(?<=[.!?])\s+/))
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function computeDiffSegments(baseLines: string[], nextLines: string[]): DiffSegment[] {
  const baseLength = baseLines.length;
  const nextLength = nextLines.length;
  const dp = Array.from({ length: baseLength + 1 }, () => Array(nextLength + 1).fill(0));

  for (let i = baseLength - 1; i >= 0; i--) {
    for (let j = nextLength - 1; j >= 0; j--) {
      if (baseLines[i] === nextLines[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const rows: DiffSegment[] = [];
  let baseIndex = 0;
  let nextIndex = 0;

  while (baseIndex < baseLength && nextIndex < nextLength) {
    if (baseLines[baseIndex] === nextLines[nextIndex]) {
      rows.push({ type: "shared", text: baseLines[baseIndex] });
      baseIndex += 1;
      nextIndex += 1;
      continue;
    }

    if (dp[baseIndex + 1][nextIndex] >= dp[baseIndex][nextIndex + 1]) {
      rows.push({ type: "removed", text: baseLines[baseIndex] });
      baseIndex += 1;
    } else {
      rows.push({ type: "added", text: nextLines[nextIndex] });
      nextIndex += 1;
    }
  }

  while (baseIndex < baseLength) {
    rows.push({ type: "removed", text: baseLines[baseIndex] });
    baseIndex += 1;
  }

  while (nextIndex < nextLength) {
    rows.push({ type: "added", text: nextLines[nextIndex] });
    nextIndex += 1;
  }

  return rows;
}

function buildContractNarrative(
  contract: ApiContract | undefined,
  objective: ContractObjectiveDocument,
  capabilityState: Record<string, boolean>
): string[] {
  if (!contract) {
    return [];
  }

  const lines: string[] = [];
  const primary = typeof objective.primary === "string" ? objective.primary : "";
  const secondary = ensureArray(objective.secondary);
  const nonGoals = ensureArray(objective.non_goals);

  if (primary.length > 0) {
    lines.push(`Primary objective: ${primary}`);
  }

  if (secondary.length > 0) {
    lines.push(`Secondary goals: ${secondary.join("; ")}`);
  }

  if (nonGoals.length > 0) {
    lines.push(`Non-goals: ${nonGoals.join("; ")}`);
  }

  const allowedCapabilities = Object.entries(capabilityLabels)
    .filter(([key]) => capabilityState[key])
    .map(([, label]) => label);
  const blockedCapabilities = Object.entries(capabilityLabels)
    .filter(([key]) => !capabilityState[key])
    .map(([, label]) => label);

  if (allowedCapabilities.length > 0) {
    lines.push(`Allowed capabilities: ${allowedCapabilities.join(", ")}`);
  }

  if (blockedCapabilities.length > 0) {
    lines.push(`Blocked capabilities: ${blockedCapabilities.join(", ")}`);
  }

  lines.push(`Risk level: ${contract.risk}`);
  lines.push(`Contract status: ${contract.status}`);
  const contractDocument = asRecord(contract.contract_json);
  const category = contractDocument?.category;
  const family = contractDocument?.family_key;
  if (typeof category === "string" && category.length > 0) {
    lines.push(`Category: ${category}`);
  }
  if (typeof family === "string" && family.length > 0) {
    lines.push(`Family key: ${family}`);
  }

  return lines;
}

export function ContractReviewPage() {
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [runs, setRuns] = useState<ApiRun[]>([]);
  const [contracts, setContracts] = useState<Record<string, ApiContract>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [actionPendingTaskId, setActionPendingTaskId] = useState<string | null>(null);

  const needsReviewTasks = useMemo(() => tasks.filter((task) => task.status === "needs_review"), [tasks]);

  const runsByTask = useMemo(() => {
    const map = new Map<string, ApiRun>();
    for (const run of runs) {
      const current = map.get(run.task_id);
      if (!current || run.created_at > current.created_at) {
        map.set(run.task_id, run);
      }
    }
    return map;
  }, [runs]);

  const selectedTask =
    needsReviewTasks.find((task) => task.id === selectedTaskId) ?? needsReviewTasks[0] ?? null;
  const selectedRun = selectedTask ? runsByTask.get(selectedTask.id) ?? null : null;
  const selectedContract = selectedRun ? contracts[selectedRun.contract_id] : undefined;

  const contractDocument = useMemo(() => asRecord(selectedContract?.contract_json), [selectedContract]);

  const contractObjective = useMemo<ContractObjectiveDocument>(() => {
    const objective = asRecord(contractDocument?.objective);
    return objective ? (objective as ContractObjectiveDocument) : {};
  }, [contractDocument]);

  const contractCapabilities = useMemo(() => {
    const capabilities = asRecord(contractDocument?.capabilities);
    if (!capabilities) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(capabilities).filter(([, value]) => typeof value === "boolean")
    ) as Record<string, boolean>;
  }, [contractDocument]);

  const contractCategoryLabel =
    contractDocument && typeof contractDocument.category === "string" ? contractDocument.category : "-";
  const contractFamilyLabel =
    contractDocument && typeof contractDocument.family_key === "string" ? contractDocument.family_key : "-";

  const contractNarrative = useMemo(
    () => buildContractNarrative(selectedContract, contractObjective, contractCapabilities),
    [selectedContract, contractObjective, contractCapabilities]
  );

  const primaryObjectiveText = useMemo(() => {
    const primary = contractObjective.primary;
    return typeof primary === "string" ? primary : "";
  }, [contractObjective]);

  const secondaryObjectives = useMemo(() => ensureArray(contractObjective.secondary), [contractObjective]);
  const nonGoalObjectives = useMemo(() => ensureArray(contractObjective.non_goals), [contractObjective]);

  const diffRows = useMemo(() => {
    if (!selectedTask || !selectedContract) {
      return [];
    }
    const requestLines = splitForDiff(selectedTask.original_request);
    if (requestLines.length === 0 || contractNarrative.length === 0) {
      return [];
    }
    return computeDiffSegments(requestLines, contractNarrative);
  }, [selectedContract, selectedTask, contractNarrative]);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const [nextTasks, nextRuns] = await Promise.all([listTasks(), listRuns()]);
      setTasks(nextTasks);
      setRuns(nextRuns);

      const needsReview = nextTasks.filter((task) => task.status === "needs_review");
      if (needsReview.length === 0) {
        setSelectedTaskId(null);
      } else if (!needsReview.some((task) => task.id === selectedTaskId)) {
        setSelectedTaskId(needsReview[0].id);
      }

      const runMap = new Map<string, ApiRun>();
      for (const run of nextRuns) {
        const current = runMap.get(run.task_id);
        if (!current || run.created_at > current.created_at) {
          runMap.set(run.task_id, run);
        }
      }

      const contractIds = new Set<string>();
      for (const task of needsReview) {
        const run = runMap.get(task.id);
        if (run?.contract_id) {
          contractIds.add(run.contract_id);
        }
      }

      if (contractIds.size > 0) {
        const entries = await Promise.all(
          Array.from(contractIds).map(async (contractId) => [contractId, await getContract(contractId)] as const)
        );
        setContracts(Object.fromEntries(entries));
      } else {
        setContracts({});
      }

      setError(null);
    } catch (refreshError) {
      setError((refreshError as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDecision(action: "approve" | "reject") {
    if (!selectedTask) {
      return;
    }
    setActionPendingTaskId(selectedTask.id);
    try {
      if (action === "approve") {
        await approveTask(selectedTask.id);
      } else {
        await rejectTask(selectedTask.id);
      }
      await refresh();
    } catch (decisionError) {
      setError((decisionError as Error).message);
    } finally {
      setActionPendingTaskId(null);
    }
  }

  return (
    <section className="content clip-card contract-review-page">
      <header className="content-header">
        <h1>Contract Review</h1>
        <p className="muted">
          Review contracts that were flagged by the orchestrator. Select a task to inspect the drafted
          contract, see the requested scope, and approve or reject the work.
        </p>
      </header>

      <div className="contract-review-grid">
        <div className="contract-review-panel contract-review-list">
          <h2>Review queue</h2>
          {loading ? (
            <p className="muted loading-state">Fetching tasks...</p>
          ) : needsReviewTasks.length === 0 ? (
            <p className="muted empty-state">No contracts currently need review.</p>
          ) : (
            <ul>
              {needsReviewTasks.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    className={`contract-review-task ${selectedTask?.id === task.id ? "active" : ""}`}
                    onClick={() => setSelectedTaskId(task.id)}
                  >
                    <span>
                      <strong>{task.title}</strong>
                      <br />
                      <small className="muted">Request: {task.original_request}</small>
                    </span>
                    <span className="muted">Created {formatDateTime(task.created_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="contract-review-panel contract-details">
          {!selectedTask ? (
            <p className="muted empty-state">Select a task to see the contract details.</p>
          ) : (
            <>
              {error ? <p className="error-banner">{error}</p> : null}
              <div className="contract-summary">
                <h3>{selectedTask.title}</h3>
                <p className="muted">Requested at {formatDateTime(selectedTask.created_at)}</p>
                <div className="contract-summary-grid">
                  <div>
                    <p className="muted">Status</p>
                    <p>{selectedTask.status}</p>
                  </div>
                  <div>
                    <p className="muted">Requires approval</p>
                    <p>{selectedTask.requires_approval ? "Yes" : "No"}</p>
                  </div>
                  <div>
                    <p className="muted">Contract</p>
                    <p>
                      {selectedContract ? (
                        <span>
                          {selectedContract.risk} risk · {selectedContract.status}
                        </span>
                      ) : (
                        <span className="muted">Awaiting contract</span>
                      )}
                    </p>
                  </div>
                </div>
              </div>

              <div className="contract-detail-section">
                <h4>Original request</h4>
                <p className="mono">{selectedTask.original_request}</p>
              </div>

              {selectedContract ? (
                <>
                  <div className="contract-detail-section contract-objectives">
                    <h4>Contract objective</h4>
                    <p>{primaryObjectiveText || "No primary objective provided."}</p>
                    {secondaryObjectives.length > 0 && (
                      <>
                        <p className="muted">Secondary goals</p>
                        <ul>
                          {secondaryObjectives.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </>
                    )}
                    {nonGoalObjectives.length > 0 && (
                      <>
                        <p className="muted">Non-goals</p>
                        <ul>
                          {nonGoalObjectives.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>

                  <div className="contract-detail-section contract-meta">
                    <h4>Capabilities & constraints</h4>
                    <div className="contract-capability-grid">
                      {Object.entries(capabilityLabels).map(([key, label]) => (
                        <div key={key} className="capability-row">
                          <span>{label}</span>
                          <span>{contractCapabilities[key] ? "Allowed" : "Blocked"}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="contract-detail-section">
                    <h4>Risk & context</h4>
                    <div className="contract-context-grid">
                      <div>
                        <p className="muted">Risk</p>
                        <p>{selectedContract.risk}</p>
                      </div>
                      <div>
                        <p className="muted">Category</p>
                        <p>{contractCategoryLabel}</p>
                      </div>
                      <div>
                        <p className="muted">Family key</p>
                        <p>{contractFamilyLabel}</p>
                      </div>
                    </div>
                  </div>

                  {selectedRun ? (
                    <div className="contract-detail-section">
                      <h4>Latest run</h4>
                      <div className="run-summary-grid">
                        <div>
                          <p className="muted">Status</p>
                          <p>{selectedRun.status}</p>
                        </div>
                        <div>
                          <p className="muted">Attempt</p>
                          <p>{selectedRun.attempt_no}</p>
                        </div>
                        <div>
                          <p className="muted">Score</p>
                          <p>{selectedRun.score ?? "-"}</p>
                        </div>
                        <div>
                          <p className="muted">Run created</p>
                          <p>{formatDateTime(selectedRun.created_at)}</p>
                        </div>
                      </div>
                      {selectedRun.outcome_summary ? (
                        <p className="muted">{selectedRun.outcome_summary}</p>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="contract-detail-section contract-diff-section">
                    <h4>Request ↔ Contract diff</h4>
                    {diffRows.length === 0 ? (
                      <p className="muted empty-state">Waiting for a richer narrative to compare.</p>
                    ) : (
                      <div className="contract-diff-grid">
                        {diffRows.map((segment, index) => (
                          <div
                            key={`${segment.type}-${index}`}
                            className={`diff-row diff-row-${segment.type}`}
                          >
                            <span className="diff-prefix">
                              {segment.type === "added"
                                ? "+"
                                : segment.type === "removed"
                                ? "-"
                                : "·"}
                            </span>
                            <span>{segment.text}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <p className="muted empty-state">
                  Contract data is not yet available; ensure the run that created this task recorded a
                  contract. When missing, the backend needs to expose the `contract_id` on the latest run.
                </p>
              )}

              <div className="contract-actions">
                <button
                  type="button"
                  className="button-link"
                  onClick={() => void handleDecision("approve")}
                  disabled={!selectedContract || actionPendingTaskId === selectedTask.id}
                >
                  {actionPendingTaskId === selectedTask.id ? "Approving…" : "Approve contract"}
                </button>
                <button
                  type="button"
                  className="button-link warning"
                  onClick={() => void handleDecision("reject")}
                  disabled={actionPendingTaskId === selectedTask.id}
                >
                  {actionPendingTaskId === selectedTask.id ? "Rejecting…" : "Reject contract"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
