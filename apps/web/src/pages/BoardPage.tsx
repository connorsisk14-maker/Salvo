import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  approveTask,
  cancelRun,
  cancelTask,
  listRuns,
  listTasks,
  rejectTask,
  retryRun,
  streamUrl,
  type ApiRun,
  type ApiTask
} from "../api/control-plane";

const activeRunStatuses = new Set(["created", "provisioning", "starting", "running", "evaluating"]);
const retryableRunStatuses = new Set(["failed", "blocked", "cancelled"]);

function missingDeliverables(findings?: string[] | null): string[] {
  if (!findings) {
    return [];
  }
  return findings
    .filter((item) => item.startsWith("Missing deliverable:"))
    .map((item) => item.replace("Missing deliverable:", "").trim());
}

export function BoardPage() {
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [runs, setRuns] = useState<ApiRun[]>([]);
  const [taskFilter, setTaskFilter] = useState("all");
  const [runFilter, setRunFilter] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const [actionBusyKey, setActionBusyKey] = useState<string | null>(null);

  async function refresh() {
    try {
      const [nextTasks, nextRuns] = await Promise.all([listTasks(), listRuns()]);
      setTasks(nextTasks);
      setRuns(nextRuns);
      setError(null);
    } catch (refreshError) {
      setError((refreshError as Error).message);
    }
  }

  useEffect(() => {
    void refresh();
    const eventSource = new EventSource(streamUrl("/stream/overview"));
    eventSource.onmessage = () => {
      void refresh();
    };
    eventSource.onerror = () => {
      // rely on EventSource internal retry behavior
    };

    return () => {
      eventSource.close();
    };
  }, []);

  const visibleTasks = useMemo(() => {
    if (taskFilter === "all") {
      return tasks;
    }
    return tasks.filter((task) => task.status === taskFilter);
  }, [tasks, taskFilter]);

  const visibleRuns = useMemo(() => {
    if (runFilter === "all") {
      return runs;
    }
    return runs.filter((run) => run.status === runFilter);
  }, [runs, runFilter]);

  const taskStatusOptions = useMemo(() => {
    const values = new Set(tasks.map((task) => task.status));
    return ["all", ...Array.from(values).sort()];
  }, [tasks]);

  const runStatusOptions = useMemo(() => {
    const values = new Set(runs.map((run) => run.status));
    return ["all", ...Array.from(values).sort()];
  }, [runs]);

  async function handleTaskApprove(taskId: string) {
    setActionBusyKey(`task-approve-${taskId}`);
    try {
      await approveTask(taskId);
      await refresh();
    } catch (actionError) {
      setError((actionError as Error).message);
    } finally {
      setActionBusyKey(null);
    }
  }

  async function handleTaskCancel(taskId: string) {
    setActionBusyKey(`task-cancel-${taskId}`);
    try {
      await cancelTask(taskId);
      await refresh();
    } catch (actionError) {
      setError((actionError as Error).message);
    } finally {
      setActionBusyKey(null);
    }
  }

  async function handleTaskReject(taskId: string) {
    setActionBusyKey(`task-reject-${taskId}`);
    try {
      await rejectTask(taskId);
      await refresh();
    } catch (actionError) {
      setError((actionError as Error).message);
    } finally {
      setActionBusyKey(null);
    }
  }

  async function handleRunRetry(runId: string) {
    setActionBusyKey(`run-retry-${runId}`);
    try {
      await retryRun(runId);
      await refresh();
    } catch (actionError) {
      setError((actionError as Error).message);
    } finally {
      setActionBusyKey(null);
    }
  }

  async function handleRunCancel(runId: string) {
    setActionBusyKey(`run-cancel-${runId}`);
    try {
      await cancelRun(runId);
      await refresh();
    } catch (actionError) {
      setError((actionError as Error).message);
    } finally {
      setActionBusyKey(null);
    }
  }

  return (
    <div className="content clip-card">
      <header className="content-header">
        <h1>Tasks & Runs Board</h1>
        <p className="muted">
          Triage queued work, investigate failures, and run control actions from one place.
        </p>
      </header>

      {error ? <p className="error-banner">{error}</p> : null}

      <section className="panel">
        <div className="board-filter-row">
          <label>
            Task status filter
            <select value={taskFilter} onChange={(event) => setTaskFilter(event.target.value)}>
              {taskStatusOptions.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
        </div>

        <h2>Tasks</h2>
        <table className="grid-table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th>Approval</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleTasks.map((task) => (
              <tr key={task.id}>
                <td>
                  <strong>{task.title}</strong>
                  <div className="mono muted">{task.id}</div>
                </td>
                <td>{task.status}</td>
                <td>
                  {task.status === "needs_review"
                    ? "contract review required"
                    : task.requires_approval
                    ? task.approved_at
                      ? "approved"
                      : "required"
                    : "not required"}
                </td>
                <td>
                  {(task.status === "needs_review" ||
                    (task.requires_approval && !task.approved_at && task.status === "queued")) ? (
                    <button
                      type="button"
                      className="button-link"
                      disabled={actionBusyKey === `task-approve-${task.id}`}
                      onClick={() => {
                        void handleTaskApprove(task.id);
                      }}
                    >
                      Approve
                    </button>
                  ) : null}
                  {task.status === "needs_review" ? (
                    <button
                      type="button"
                      className="button-link"
                      disabled={actionBusyKey === `task-reject-${task.id}`}
                      onClick={() => {
                        void handleTaskReject(task.id);
                      }}
                    >
                      Reject
                    </button>
                  ) : null}
                  {!["completed", "failed", "cancelled"].includes(task.status) ? (
                    <button
                      type="button"
                      className="button-link"
                      disabled={actionBusyKey === `task-cancel-${task.id}`}
                      onClick={() => {
                        void handleTaskCancel(task.id);
                      }}
                    >
                      Cancel
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <div className="board-filter-row">
          <label>
            Run status filter
            <select value={runFilter} onChange={(event) => setRunFilter(event.target.value)}>
              {runStatusOptions.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
        </div>

        <h2>Runs</h2>
        <table className="grid-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Status</th>
              <th>Failure / Eval</th>
              <th>Score</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleRuns.map((run) => (
              <tr key={run.id}>
                <td>
                  <Link to={`/runs/${run.id}`} className="mono">
                    {run.id}
                  </Link>
                  <div className="muted mono">task {run.task_id}</div>
                </td>
                <td>{run.status}</td>
                <td>
                  <div className="muted">exit: {run.exit_reason ?? "-"}</div>
                  <div className="muted">hard-fail: {run.hard_fail_reason ?? "-"}</div>
                  {missingDeliverables(run.findings_json).length > 0 ? (
                    <div className="muted">
                      missing: {missingDeliverables(run.findings_json).join(", ")}
                    </div>
                  ) : (
                    <div className="muted">missing: -</div>
                  )}
                </td>
                <td>{run.score ?? "-"}</td>
                <td>
                  {retryableRunStatuses.has(run.status) ? (
                    <button
                      type="button"
                      className="button-link"
                      disabled={actionBusyKey === `run-retry-${run.id}`}
                      onClick={() => {
                        void handleRunRetry(run.id);
                      }}
                    >
                      Retry
                    </button>
                  ) : null}
                  {activeRunStatuses.has(run.status) ? (
                    <button
                      type="button"
                      className="button-link"
                      disabled={actionBusyKey === `run-cancel-${run.id}`}
                      onClick={() => {
                        void handleRunCancel(run.id);
                      }}
                    >
                      Cancel run
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
