import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  approveTask,
  cancelRun,
  cancelTask,
  getArtifactPreview,
  getArtifactContentObjectUrl,
  getRunDetail,
  getRunEvents,
  listRuns,
  listTasks,
  openArtifactContent,
  rejectTask,
  retryRun,
  type ApiArtifactPreview,
  type ApiRun,
  type ApiRunDetail,
  type ApiRunEvent,
  type ApiTask
} from "../api/control-plane";

const activeRunStatuses = new Set(["created", "provisioning", "starting", "running", "evaluating"]);
const retryableRunStatuses = new Set(["failed", "blocked", "cancelled"]);
const terminalTaskStatuses = new Set(["completed", "failed", "cancelled"]);

type PanelKind = "contract" | "proof" | "timeline";
type QueueFilter = "all" | "actionable" | "needs_review" | "queued" | "active" | "retryable" | "terminal";
type QueueBucket = Exclude<QueueFilter, "all" | "actionable">;

type BoardItem = {
  task: ApiTask;
  latestRun: ApiRun | null;
  contractCategory: string;
  contractSubcategory: string | null;
  contractFamilyKey: string | null;
  categoryFilterValue: string;
  queueBucket: QueueBucket;
  priorityRank: number;
  priorityLabel: string;
  actionable: boolean;
};

function missingDeliverables(findings?: string[] | null): string[] {
  if (!findings) {
    return [];
  }
  return findings
    .filter((item) => item.startsWith("Missing deliverable:"))
    .map((item) => item.replace("Missing deliverable:", "").trim());
}

function parsePanel(value: string | null): PanelKind {
  if (value === "proof" || value === "timeline" || value === "contract") {
    return value;
  }
  return "contract";
}

function readStringField(
  source: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  if (!source) {
    return null;
  }
  const value = source[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function canApproveTask(task: ApiTask): boolean {
  return task.status === "needs_review" || (task.requires_approval && !task.approved_at && task.status === "queued");
}

function canRejectTask(task: ApiTask): boolean {
  return task.status === "needs_review";
}

function canCancelTask(task: ApiTask): boolean {
  return !terminalTaskStatuses.has(task.status);
}

function classifyBoardItem(task: ApiTask, latestRun: ApiRun | null): Pick<BoardItem, "queueBucket" | "priorityRank" | "priorityLabel" | "actionable"> {
  if (canApproveTask(task)) {
    return {
      queueBucket: "needs_review",
      priorityRank: 0,
      priorityLabel: "needs approval",
      actionable: true
    };
  }

  if (task.status === "queued") {
    return {
      queueBucket: "queued",
      priorityRank: 1,
      priorityLabel: "queued",
      actionable: true
    };
  }

  if (latestRun && activeRunStatuses.has(latestRun.status)) {
    return {
      queueBucket: "active",
      priorityRank: 2,
      priorityLabel: "active run",
      actionable: true
    };
  }

  if (latestRun && retryableRunStatuses.has(latestRun.status)) {
    return {
      queueBucket: "retryable",
      priorityRank: 3,
      priorityLabel: "retryable",
      actionable: true
    };
  }

  return {
    queueBucket: "terminal",
    priorityRank: 4,
    priorityLabel: "terminal",
    actionable: false
  };
}

function deriveBoardItems(tasks: ApiTask[], runs: ApiRun[]): BoardItem[] {
  const sortedRuns = [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const latestRunByTaskId = new Map<string, ApiRun>();
  for (const run of sortedRuns) {
    if (!latestRunByTaskId.has(run.task_id)) {
      latestRunByTaskId.set(run.task_id, run);
    }
  }

  return tasks
    .map((task) => {
      const latestRun = latestRunByTaskId.get(task.id) ?? null;
      const classification = classifyBoardItem(task, latestRun);
      return {
        task,
        latestRun,
        contractCategory: latestRun?.contract_category ?? "general",
        contractSubcategory: latestRun?.contract_subcategory ?? null,
        contractFamilyKey: latestRun?.contract_family_key ?? null,
        categoryFilterValue: latestRun?.contract_category ?? "uncategorized",
        ...classification
      };
    })
    .sort((a, b) => {
      if (a.priorityRank !== b.priorityRank) {
        return a.priorityRank - b.priorityRank;
      }
      if (a.task.created_at !== b.task.created_at) {
        return a.task.created_at.localeCompare(b.task.created_at);
      }
      return a.task.id.localeCompare(b.task.id);
    });
}

function matchesQueueFilter(item: BoardItem, filter: QueueFilter): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "actionable") {
    return item.actionable;
  }
  return item.queueBucket === filter;
}

function matchesCategoryFilter(item: BoardItem, filter: string): boolean {
  if (filter === "all") {
    return true;
  }
  return item.categoryFilterValue === filter;
}

function statusTone(value: string | null | undefined): "ready" | "warn" | "error" {
  if (!value) {
    return "warn";
  }
  if (["completed", "approved", "passed", "ready", "healthy"].includes(value)) {
    return "ready";
  }
  if (["failed", "blocked", "cancelled", "rejected", "hard_failed", "error", "offline"].includes(value)) {
    return "error";
  }
  return "warn";
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

export function BoardPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [runs, setRuns] = useState<ApiRun[]>([]);
  const [queueFilter, setQueueFilter] = useState<QueueFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const [actionBusyKey, setActionBusyKey] = useState<string | null>(null);
  const [familyCopyStatus, setFamilyCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  const [runDetailsById, setRunDetailsById] = useState<Record<string, ApiRunDetail>>({});
  const [runEventsById, setRunEventsById] = useState<Record<string, ApiRunEvent[]>>({});
  const [detailBusyRunId, setDetailBusyRunId] = useState<string | null>(null);

  const [artifactPreviews, setArtifactPreviews] = useState<Record<string, ApiArtifactPreview>>({});
  const [artifactContentUrls, setArtifactContentUrls] = useState<Record<string, string>>({});
  const [previewBusy, setPreviewBusy] = useState<Record<string, boolean>>({});
  const artifactContentUrlsRef = useRef<Record<string, string>>({});

  const selectedTaskId = searchParams.get("taskId");
  const selectedRunIdParam = searchParams.get("runId");
  const panelParam = searchParams.get("panel");
  const activePanel = parsePanel(panelParam);

  const updateQuery = useCallback(
    (
      next: {
        taskId?: string | null;
        runId?: string | null;
        panel?: PanelKind | null;
      },
      replace = false
    ) => {
      setSearchParams(
        (previous) => {
          const params = new URLSearchParams(previous);

          if (next.taskId !== undefined) {
            if (next.taskId) {
              params.set("taskId", next.taskId);
            } else {
              params.delete("taskId");
            }
          }

          if (next.runId !== undefined) {
            if (next.runId) {
              params.set("runId", next.runId);
            } else {
              params.delete("runId");
            }
          }

          if (next.panel !== undefined) {
            if (next.panel) {
              params.set("panel", next.panel);
            } else {
              params.delete("panel");
            }
          }

          return params;
        },
        { replace }
      );
    },
    [setSearchParams]
  );

  const refresh = useCallback(async () => {
    try {
      const [nextTasks, nextRuns] = await Promise.all([listTasks(), listRuns()]);
      setTasks(nextTasks);
      setRuns(nextRuns);
      setError(null);
    } catch (refreshError) {
      setError((refreshError as Error).message);
    }
  }, []);

  useEffect(() => {
    artifactContentUrlsRef.current = artifactContentUrls;
  }, [artifactContentUrls]);

  useEffect(() => {
    return () => {
      for (const url of Object.values(artifactContentUrlsRef.current)) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  useEffect(() => {
    if (!panelParam) {
      updateQuery({ panel: "contract" }, true);
    }
  }, [panelParam, updateQuery]);

  useEffect(() => {
    void refresh();
    const intervalId = window.setInterval(() => {
      void refresh();
    }, 1500);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [refresh]);

  const boardItems = useMemo(() => deriveBoardItems(tasks, runs), [tasks, runs]);

  const counts = useMemo(() => {
    const tally: Record<QueueFilter, number> = {
      all: boardItems.length,
      actionable: 0,
      needs_review: 0,
      queued: 0,
      active: 0,
      retryable: 0,
      terminal: 0
    };

    for (const item of boardItems) {
      if (item.actionable) {
        tally.actionable += 1;
      }
      tally[item.queueBucket] += 1;
    }

    return tally;
  }, [boardItems]);

  const categoryFilterOptions = useMemo(() => {
    const categories = new Set<string>();
    for (const item of boardItems) {
      categories.add(item.categoryFilterValue);
    }
    return ["all", ...Array.from(categories).sort()];
  }, [boardItems]);

  const visibleItems = useMemo(
    () =>
      boardItems.filter(
        (item) => matchesQueueFilter(item, queueFilter) && matchesCategoryFilter(item, categoryFilter)
      ),
    [boardItems, categoryFilter, queueFilter]
  );

  const selectedItem = useMemo(() => {
    if (visibleItems.length === 0) {
      return null;
    }

    if (selectedTaskId) {
      const byTask = visibleItems.find((item) => item.task.id === selectedTaskId);
      if (byTask) {
        return byTask;
      }
    }

    if (selectedRunIdParam) {
      const byRun = visibleItems.find((item) => item.latestRun?.id === selectedRunIdParam);
      if (byRun) {
        return byRun;
      }
    }

    return null;
  }, [visibleItems, selectedTaskId, selectedRunIdParam]);

  useEffect(() => {
    if (visibleItems.length === 0) {
      if (selectedTaskId || selectedRunIdParam) {
        updateQuery({ taskId: null, runId: null }, true);
      }
      return;
    }

    const fallback = visibleItems[0];
    const selected = selectedItem ?? fallback;

    const expectedTaskId = selected.task.id;
    const expectedRunId = selected.latestRun?.id ?? null;

    if (selectedTaskId !== expectedTaskId || (selectedRunIdParam ?? null) !== expectedRunId) {
      updateQuery(
        {
          taskId: expectedTaskId,
          runId: expectedRunId
        },
        true
      );
    }
  }, [selectedItem, selectedRunIdParam, selectedTaskId, updateQuery, visibleItems]);

  const selectedRunId = selectedItem?.latestRun?.id ?? null;
  const selectedRun = selectedItem?.latestRun ?? null;
  const selectedRunDetail = selectedRunId ? runDetailsById[selectedRunId] ?? null : null;
  const selectedEvents = selectedRunId ? runEventsById[selectedRunId] ?? [] : [];

  useEffect(() => {
    setFamilyCopyStatus("idle");
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedRunId || (runDetailsById[selectedRunId] && runEventsById[selectedRunId])) {
      return;
    }
    const runId = selectedRunId;

    let cancelled = false;

    async function loadRunContext() {
      setDetailBusyRunId(runId);
      try {
        const [detail, events] = await Promise.all([getRunDetail(runId), getRunEvents(runId)]);

        if (cancelled) {
          return;
        }

        setRunDetailsById((current) => ({
          ...current,
          [runId]: detail
        }));
        setRunEventsById((current) => ({
          ...current,
          [runId]: events
        }));
        setError(null);
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        setError((loadError as Error).message);
      } finally {
        if (!cancelled) {
          setDetailBusyRunId(null);
        }
      }
    }

    void loadRunContext();

    return () => {
      cancelled = true;
    };
  }, [runDetailsById, runEventsById, selectedRunId]);

  const handleTaskApprove = useCallback(
    async (taskId: string) => {
      setActionBusyKey(`task-approve-${taskId}`);
      try {
        await approveTask(taskId);
        await refresh();
      } catch (actionError) {
        setError((actionError as Error).message);
      } finally {
        setActionBusyKey(null);
      }
    },
    [refresh]
  );

  const handleTaskCancel = useCallback(
    async (taskId: string) => {
      setActionBusyKey(`task-cancel-${taskId}`);
      try {
        await cancelTask(taskId);
        await refresh();
      } catch (actionError) {
        setError((actionError as Error).message);
      } finally {
        setActionBusyKey(null);
      }
    },
    [refresh]
  );

  const handleTaskReject = useCallback(
    async (taskId: string) => {
      setActionBusyKey(`task-reject-${taskId}`);
      try {
        await rejectTask(taskId);
        await refresh();
      } catch (actionError) {
        setError((actionError as Error).message);
      } finally {
        setActionBusyKey(null);
      }
    },
    [refresh]
  );

  const handleRunRetry = useCallback(
    async (runId: string) => {
      setActionBusyKey(`run-retry-${runId}`);
      try {
        await retryRun(runId);
        await refresh();
      } catch (actionError) {
        setError((actionError as Error).message);
      } finally {
        setActionBusyKey(null);
      }
    },
    [refresh]
  );

  const handleRunCancel = useCallback(
    async (runId: string) => {
      setActionBusyKey(`run-cancel-${runId}`);
      try {
        await cancelRun(runId);
        await refresh();
      } catch (actionError) {
        setError((actionError as Error).message);
      } finally {
        setActionBusyKey(null);
      }
    },
    [refresh]
  );

  const loadArtifactPreview = useCallback(
    async (artifactId: string) => {
      if (artifactPreviews[artifactId]) {
        return;
      }

      setPreviewBusy((current) => ({
        ...current,
        [artifactId]: true
      }));

      try {
        const preview = await getArtifactPreview(artifactId);
        if (preview.kind === "image" && !artifactContentUrlsRef.current[artifactId]) {
          const objectUrl = await getArtifactContentObjectUrl(artifactId);
          setArtifactContentUrls((current) => {
            if (current[artifactId]) {
              URL.revokeObjectURL(objectUrl);
              return current;
            }
            return {
              ...current,
              [artifactId]: objectUrl
            };
          });
        }
        setArtifactPreviews((current) => ({
          ...current,
          [artifactId]: preview
        }));
        setError(null);
      } catch (previewError) {
        setError((previewError as Error).message);
      } finally {
        setPreviewBusy((current) => ({
          ...current,
          [artifactId]: false
        }));
      }
    },
    [artifactPreviews]
  );

  const handleOpenArtifact = useCallback(async (artifactId: string) => {
    try {
      await openArtifactContent(artifactId);
      setError(null);
    } catch (artifactError) {
      setError((artifactError as Error).message);
    }
  }, []);

  const handleCopyFamilyKey = useCallback(async () => {
    const familyKey =
      readStringField(selectedRunDetail?.contract.contract_json, "family_key") ??
      selectedRun?.contract_family_key ??
      null;
    if (!familyKey) {
      setFamilyCopyStatus("failed");
      return;
    }

    if (typeof navigator === "undefined" || !navigator.clipboard) {
      setFamilyCopyStatus("failed");
      return;
    }

    try {
      await navigator.clipboard.writeText(familyKey);
      setFamilyCopyStatus("copied");
    } catch {
      setFamilyCopyStatus("failed");
    }
  }, [selectedRun, selectedRunDetail]);

  const queueFilters: Array<{ value: QueueFilter; label: string }> = [
    { value: "all", label: "all" },
    { value: "actionable", label: "actionable" },
    { value: "needs_review", label: "needs review" },
    { value: "queued", label: "queued" },
    { value: "active", label: "active" },
    { value: "retryable", label: "retryable" },
    { value: "terminal", label: "terminal" }
  ];

  const panelTabs: PanelKind[] = ["contract", "proof", "timeline"];

  const canApprove = selectedItem ? canApproveTask(selectedItem.task) : false;
  const canReject = selectedItem ? canRejectTask(selectedItem.task) : false;
  const canCancel = selectedItem ? canCancelTask(selectedItem.task) : false;

  const canRetry = selectedRun ? retryableRunStatuses.has(selectedRun.status) : false;
  const canCancelSelectedRun = selectedRun ? activeRunStatuses.has(selectedRun.status) : false;

  const eventExcerpt = [...selectedEvents].sort((a, b) => b.sequence_no - a.sequence_no).slice(0, 18);
  const selectedContractCategory =
    readStringField(selectedRunDetail?.contract.contract_json, "category") ??
    selectedRun?.contract_category ??
    null;
  const selectedContractSubcategory =
    readStringField(selectedRunDetail?.contract.contract_json, "subcategory") ??
    selectedRun?.contract_subcategory ??
    null;
  const selectedContractFamilyKey =
    readStringField(selectedRunDetail?.contract.contract_json, "family_key") ??
    selectedRun?.contract_family_key ??
    null;

  return (
    <div className="content clip-card">
      <header className="content-header">
        <h1>Operations Cockpit</h1>
        <p className="muted">
          Prioritized triage for contracts and tasks with approvals, run control, proof, and timeline context in one view.
        </p>
      </header>

      {error ? <p className="error-banner">{error}</p> : null}

      <section className="panel board-panel-switch" aria-label="Board panel focus">
        <span className="muted">Focus</span>
        <div className="board-filter-pills">
          {panelTabs.map((panel) => (
            <button
              key={panel}
              type="button"
              className={`button-link ${activePanel === panel ? "board-pill-active" : ""}`}
              onClick={() => {
                updateQuery({ panel });
              }}
            >
              {panel}
            </button>
          ))}
        </div>
      </section>

      <div className="board-cockpit">
        <aside className="panel board-queue">
          <div className="board-section-head">
            <h2>Action Queue</h2>
            <span className="muted mono">{visibleItems.length} visible</span>
          </div>

          <div className="board-filter-pills">
            {queueFilters.map((filter) => (
              <button
                key={filter.value}
                type="button"
                className={`button-link ${queueFilter === filter.value ? "board-pill-active" : ""}`}
                onClick={() => {
                  setQueueFilter(filter.value);
                }}
              >
                {filter.label} ({counts[filter.value]})
              </button>
            ))}
          </div>
          <div className="board-category-filter">
            <label>
              Category
              <select
                value={categoryFilter}
                onChange={(event) => {
                  setCategoryFilter(event.target.value);
                }}
              >
                {categoryFilterOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {visibleItems.length === 0 ? (
            <p className="muted">No tasks match this filter.</p>
          ) : (
            <ul className="board-queue-list">
              {visibleItems.map((item) => {
                const isSelected = selectedItem?.task.id === item.task.id;
                return (
                  <li key={item.task.id}>
                    <button
                      type="button"
                      className={`board-queue-item ${isSelected ? "board-queue-item-active" : ""}`}
                      onClick={() => {
                        updateQuery({
                          taskId: item.task.id,
                          runId: item.latestRun?.id ?? null
                        });
                      }}
                    >
                      <div className="board-queue-item-head">
                        <strong>{item.task.title}</strong>
                        <span className={`status-pill board-chip-${statusTone(item.task.status)}`}>{item.priorityLabel}</span>
                      </div>
                      <div className="muted mono">{item.task.id}</div>
                      <div className="board-chip-row">
                        <span className={`status-pill board-chip-${statusTone(item.task.status)}`}>
                          task {item.task.status}
                        </span>
                        {item.latestRun ? (
                          <span className={`status-pill board-chip-${statusTone(item.latestRun.status)}`}>
                            run {item.latestRun.status}
                          </span>
                        ) : (
                          <span className="status-pill board-chip-warn">run pending</span>
                        )}
                        {item.latestRun ? (
                          <span className="status-pill board-chip-neutral">
                            {item.contractCategory}
                            {item.contractSubcategory ? `/${item.contractSubcategory}` : ""}
                          </span>
                        ) : null}
                      </div>
                      <div className="muted">Created {formatTimestamp(item.task.created_at)}</div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section className={`panel board-workspace ${activePanel === "contract" ? "" : "board-mobile-hidden"}`}>
          <div className="board-section-head">
            <h2>Contract & Task</h2>
            {selectedItem ? (
              <span className="muted mono">{selectedItem.task.id}</span>
            ) : (
              <span className="muted">No selection</span>
            )}
          </div>

          {!selectedItem ? (
            <p className="muted">Select a task to inspect contract context and actions.</p>
          ) : (
            <>
              <div className="board-info-grid">
                <article className="board-info-card">
                  <h3>Task</h3>
                  <p>
                    <strong>{selectedItem.task.title}</strong>
                  </p>
                  <p className="muted">{selectedItem.task.original_request}</p>
                  <p>
                    Status: <span className="mono">{selectedItem.task.status}</span>
                  </p>
                  <p>
                    Approval: <strong>{canApproveTask(selectedItem.task) ? "required" : "satisfied"}</strong>
                  </p>
                </article>

                <article className="board-info-card">
                  <h3>Run Health</h3>
                  {selectedItem.latestRun ? (
                    <>
                      <p>
                        Run: <Link to={`/runs/${selectedItem.latestRun.id}`} className="mono">{selectedItem.latestRun.id}</Link>
                      </p>
                      <p>
                        Status: <strong>{selectedItem.latestRun.status}</strong>
                      </p>
                      <p>
                        Attempt: <strong>{selectedItem.latestRun.attempt_no}</strong>
                      </p>
                      <p className="muted">Exit: {selectedItem.latestRun.exit_reason ?? "-"}</p>
                      <p className="muted">Hard fail: {selectedItem.latestRun.hard_fail_reason ?? "-"}</p>
                    </>
                  ) : (
                    <p className="muted">No run started yet.</p>
                  )}
                </article>

                <article className="board-info-card">
                  <h3>Evaluation Snapshot</h3>
                  {selectedItem.latestRun ? (
                    <>
                      <p>
                        Outcome: <strong>{selectedItem.latestRun.evaluation_outcome ?? "pending"}</strong>
                      </p>
                      <p>
                        Score: <strong>{selectedItem.latestRun.score ?? "-"}</strong>
                      </p>
                      <p>
                        Missing deliverables: {missingDeliverables(selectedItem.latestRun.findings_json).join(", ") || "-"}
                      </p>
                    </>
                  ) : (
                    <p className="muted">Evaluation unavailable until a run exists.</p>
                  )}
                </article>
              </div>

              <article className="board-info-card board-contract-card">
                <h3>Contract Summary</h3>
                {selectedRun ? (
                  <div className="board-contract-classification">
                    <span className="status-pill board-chip-neutral">
                      category {selectedContractCategory ?? "unknown"}
                    </span>
                    <span className="status-pill board-chip-neutral">
                      subcategory {selectedContractSubcategory ?? "-"}
                    </span>
                    <span className="status-pill board-chip-neutral">
                      family {selectedContractFamilyKey ?? "-"}
                    </span>
                    <button
                      type="button"
                      className="button-link board-copy-button"
                      disabled={!selectedContractFamilyKey}
                      onClick={() => {
                        void handleCopyFamilyKey();
                      }}
                    >
                      Copy family key
                    </button>
                    {familyCopyStatus === "copied" ? (
                      <span className="muted">Copied.</span>
                    ) : null}
                    {familyCopyStatus === "failed" ? (
                      <span className="muted">Copy unavailable.</span>
                    ) : null}
                  </div>
                ) : null}
                {selectedRunId && selectedRunDetail ? (
                  <>
                    <p>
                      Contract: <span className="mono">{selectedRunDetail.contract.id}</span>
                    </p>
                    <p>
                      Status: <strong>{selectedRunDetail.contract.status}</strong>
                    </p>
                    <p>
                      Risk: <strong>{selectedRunDetail.contract.risk}</strong>
                    </p>
                    <pre className="json-block">{JSON.stringify(selectedRunDetail.contract.contract_json, null, 2)}</pre>
                  </>
                ) : selectedRunId && detailBusyRunId === selectedRunId ? (
                  <p className="muted">Loading contract details...</p>
                ) : (
                  <p className="muted">Contract details will appear when a run is available.</p>
                )}
              </article>

              <div className="board-action-bar">
                <span className="muted mono">Control actions</span>
                <div className="board-action-buttons">
                  {canApprove ? (
                    <button
                      type="button"
                      className="button-link"
                      disabled={actionBusyKey === `task-approve-${selectedItem.task.id}`}
                      onClick={() => {
                        void handleTaskApprove(selectedItem.task.id);
                      }}
                    >
                      Approve task
                    </button>
                  ) : null}

                  {canReject ? (
                    <button
                      type="button"
                      className="button-link"
                      disabled={actionBusyKey === `task-reject-${selectedItem.task.id}`}
                      onClick={() => {
                        void handleTaskReject(selectedItem.task.id);
                      }}
                    >
                      Reject task
                    </button>
                  ) : null}

                  {canCancel ? (
                    <button
                      type="button"
                      className="button-link"
                      disabled={actionBusyKey === `task-cancel-${selectedItem.task.id}`}
                      onClick={() => {
                        void handleTaskCancel(selectedItem.task.id);
                      }}
                    >
                      Cancel task
                    </button>
                  ) : null}

                  {selectedRun && canRetry ? (
                    <button
                      type="button"
                      className="button-link"
                      disabled={actionBusyKey === `run-retry-${selectedRun.id}`}
                      onClick={() => {
                        void handleRunRetry(selectedRun.id);
                      }}
                    >
                      Retry run
                    </button>
                  ) : null}

                  {selectedRun && canCancelSelectedRun ? (
                    <button
                      type="button"
                      className="button-link"
                      disabled={actionBusyKey === `run-cancel-${selectedRun.id}`}
                      onClick={() => {
                        void handleRunCancel(selectedRun.id);
                      }}
                    >
                      Cancel run
                    </button>
                  ) : null}
                </div>
              </div>
            </>
          )}
        </section>

        <aside className={`panel board-drawer ${activePanel === "contract" ? "board-mobile-hidden" : ""}`}>
          <div className="board-section-head">
            <h2>Proof & Timeline</h2>
            <div className="board-filter-pills">
              <button
                type="button"
                className={`button-link ${activePanel === "proof" ? "board-pill-active" : ""}`}
                onClick={() => {
                  updateQuery({ panel: "proof" });
                }}
              >
                proof
              </button>
              <button
                type="button"
                className={`button-link ${activePanel === "timeline" ? "board-pill-active" : ""}`}
                onClick={() => {
                  updateQuery({ panel: "timeline" });
                }}
              >
                timeline
              </button>
            </div>
          </div>

          {!selectedRunId ? (
            <p className="muted">No run selected yet. Start with contract review or queued task actions.</p>
          ) : activePanel === "timeline" ? (
            <>
              <p className="muted">Latest run events ({eventExcerpt.length})</p>
              {eventExcerpt.length === 0 ? (
                <p className="muted">Timeline loading...</p>
              ) : (
                <ul className="board-timeline-list">
                  {eventExcerpt.map((event) => (
                    <li key={event.id} className="board-timeline-item">
                      <div className="board-timeline-meta">
                        <span className="mono">#{event.sequence_no}</span>
                        <span className={`status-pill board-chip-${statusTone(event.level)}`}>{event.level}</span>
                        <span className="muted mono">{event.event_type}</span>
                      </div>
                      <pre className="json-inline">{JSON.stringify(event.payload_json, null, 2)}</pre>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              <div className="board-proof-actions">
                <Link to={`/runs/${selectedRunId}#proof`} className="button-link">
                  Open full proof
                </Link>
              </div>

              {!selectedRunDetail ? (
                <p className="muted">Loading proof context...</p>
              ) : selectedRunDetail.artifacts.length === 0 ? (
                <p className="muted">No artifacts recorded for this run.</p>
              ) : (
                <ul className="board-artifact-list">
                  {selectedRunDetail.artifacts.map((artifact) => {
                    const preview = artifactPreviews[artifact.id];

                    return (
                      <li key={artifact.id} className="board-artifact-item">
                        <div className="board-artifact-head">
                          <strong>{artifact.artifact_type}</strong>
                          <span className="muted mono">{artifact.id}</span>
                        </div>
                        <p className="muted mono">{artifact.path}</p>
                        <p className="muted">Created {formatTimestamp(artifact.created_at)}</p>
                        <div className="board-artifact-actions">
                          <button
                            type="button"
                            className="button-link"
                            disabled={previewBusy[artifact.id] === true}
                            onClick={() => {
                              void handleOpenArtifact(artifact.id);
                            }}
                          >
                            Open file
                          </button>
                          <button
                            type="button"
                            className="button-link"
                            disabled={previewBusy[artifact.id] === true}
                            onClick={() => {
                              void loadArtifactPreview(artifact.id);
                            }}
                          >
                            {previewBusy[artifact.id] ? "Loading..." : "Preview"}
                          </button>
                        </div>

                        {preview ? (
                          <article className="proof-preview-card">
                            {preview.kind === "text" ? (
                              <>
                                <pre className="json-block">{preview.content}</pre>
                                {preview.truncated ? (
                                  <p className="muted">Preview truncated to first 64 KB.</p>
                                ) : null}
                              </>
                            ) : null}

                            {preview.kind === "image" ? (
                              <img
                                src={artifactContentUrls[artifact.id]}
                                alt={`Artifact ${artifact.id}`}
                                className="proof-preview-image"
                              />
                            ) : null}

                            {preview.kind === "binary" ? (
                              <p className="muted">Binary artifact. Use Open file to inspect.</p>
                            ) : null}
                          </article>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}

              <h3>Final Payload</h3>
              {selectedRunDetail?.final_payload ? (
                <pre className="json-block">{JSON.stringify(selectedRunDetail.final_payload, null, 2)}</pre>
              ) : (
                <p className="muted">Final payload not available.</p>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
