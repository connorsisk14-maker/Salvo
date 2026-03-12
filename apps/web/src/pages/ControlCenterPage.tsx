import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  approveTask,
  cancelTask,
  createTask,
  forceRestartDaemon,
  getOrchestratorHealth,
  getResearchHealth,
  listRuns,
  listTasks,
  streamUrl,
  type ApiDaemonHealth,
  type ApiRestartTarget,
  type ApiRun,
  type ApiTask
} from "../api/control-plane";

function renderHeartbeatDate(value?: string): string {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleTimeString();
}

export function ControlCenterPage() {
  const [title, setTitle] = useState("Create run summary scaffolding");
  const [request, setRequest] = useState(
    "Create a sample markdown artifact that summarizes this run."
  );
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [runs, setRuns] = useState<ApiRun[]>([]);
  const [orchestratorHealth, setOrchestratorHealth] = useState<ApiDaemonHealth | null>(null);
  const [researchHealth, setResearchHealth] = useState<ApiDaemonHealth | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [restartTarget, setRestartTarget] = useState<ApiRestartTarget | null>(null);
  const [restartMessage, setRestartMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sortedRuns = useMemo(
    () => [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [runs]
  );

  async function refresh() {
    try {
      const [nextTasks, nextRuns, nextOrchestratorHealth, nextResearchHealth] =
        await Promise.all([
          listTasks(),
          listRuns(),
          getOrchestratorHealth(),
          getResearchHealth()
        ]);
      setTasks(nextTasks);
      setRuns(nextRuns);
      setOrchestratorHealth(nextOrchestratorHealth);
      setResearchHealth(nextResearchHealth);
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

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await createTask({
        title,
        request,
        requiresApproval
      });
      setRequest("");
      await refresh();
      setError(null);
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function onForceRestart(target: ApiRestartTarget) {
    const confirmed = window.confirm(
      `Force restart ${target === "all" ? "both daemons" : `${target} daemon`} now?`
    );
    if (!confirmed) {
      return;
    }

    setRestartTarget(target);
    try {
      const response = await forceRestartDaemon(target);
      const summary = response.results
        .map(
          (result) =>
            `${result.daemon}: ${result.started ? "started" : "not started"} (pid ${
              result.pid ?? "-"
            }, ${result.note})`
        )
        .join(" | ");
      setRestartMessage(summary);

      setTimeout(() => {
        void refresh();
      }, 1500);
      setTimeout(() => {
        void refresh();
      }, 5000);
    } catch (restartError) {
      setRestartMessage(`Restart failed: ${(restartError as Error).message}`);
    } finally {
      setRestartTarget(null);
    }
  }

  return (
    <div className="content clip-card">
      <header className="content-header">
        <h1>Control Center</h1>
        <p className="muted">
          Submit tasks to the control plane. The orchestrator daemon claims queued work and spawns bounded runners.
        </p>
      </header>

      {error ? <p className="error-banner">{error}</p> : null}

      <section className="panel">
        <h2>Daemon Health</h2>
        <div className="health-grid">
          <article className="health-card">
            <div className="health-card-head">
              <h3>Orchestrator</h3>
              <span className={`status-pill status-${orchestratorHealth?.status ?? "offline"}`}>
                {orchestratorHealth?.status ?? "offline"}
              </span>
            </div>
            <p className="muted">
              Daemon: <span className="mono">{orchestratorHealth?.daemon_id ?? "-"}</span>
            </p>
            <p className="muted">Heartbeat: {renderHeartbeatDate(orchestratorHealth?.heartbeat_at)}</p>
            <p className="muted">Age: {orchestratorHealth?.age_seconds ?? "-"}s</p>
            <p className="muted">
              Active runs: {(orchestratorHealth?.metadata?.active_runs as number | undefined) ?? "-"}
            </p>
          </article>

          <article className="health-card">
            <div className="health-card-head">
              <h3>Research</h3>
              <span className={`status-pill status-${researchHealth?.status ?? "offline"}`}>
                {researchHealth?.status ?? "offline"}
              </span>
            </div>
            <p className="muted">
              Daemon: <span className="mono">{researchHealth?.daemon_id ?? "-"}</span>
            </p>
            <p className="muted">Heartbeat: {renderHeartbeatDate(researchHealth?.heartbeat_at)}</p>
            <p className="muted">Age: {researchHealth?.age_seconds ?? "-"}s</p>
            <p className="muted">
              Processing:{" "}
              {typeof researchHealth?.metadata?.processing === "boolean"
                ? String(researchHealth.metadata.processing)
                : "-"}
            </p>
          </article>
        </div>

        <details className="restart-controls">
          <summary>Restart Controls</summary>
          <p className="muted">
            Force restart will kill matching daemon process names and launch fresh daemon processes.
          </p>
          <div className="restart-actions">
            <button
              className="button-link"
              disabled={restartTarget !== null}
              onClick={() => {
                void onForceRestart("orchestrator");
              }}
              type="button"
            >
              {restartTarget === "orchestrator" ? "Restarting..." : "Force restart orchestrator"}
            </button>
            <button
              className="button-link"
              disabled={restartTarget !== null}
              onClick={() => {
                void onForceRestart("research");
              }}
              type="button"
            >
              {restartTarget === "research" ? "Restarting..." : "Force restart research"}
            </button>
            <button
              className="button-link"
              disabled={restartTarget !== null}
              onClick={() => {
                void onForceRestart("all");
              }}
              type="button"
            >
              {restartTarget === "all" ? "Restarting..." : "Force restart both"}
            </button>
          </div>
          {restartMessage ? <p className="muted restart-note">{restartMessage}</p> : null}
        </details>
      </section>

      <section className="panel">
        <h2>Submit Task</h2>
        <form onSubmit={onSubmit} className="form-grid">
          <label>
            Title
            <input value={title} onChange={(event) => setTitle(event.target.value)} required />
          </label>
          <label>
            Request
            <textarea
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              rows={5}
              required
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={requiresApproval}
              onChange={(event) => setRequiresApproval(event.target.checked)}
            />
            Require manual approval before daemon claim
          </label>
          <button className="button-link" disabled={submitting} type="submit">
            {submitting ? "Submitting..." : "Submit task"}
          </button>
        </form>
      </section>

      <section className="panel">
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
            {tasks.map((task) => (
              <tr key={task.id}>
                <td>
                  <strong>{task.title}</strong>
                  <div className="muted mono">{task.id}</div>
                </td>
                <td>{task.status}</td>
                <td>
                  {task.requires_approval
                    ? task.approved_at
                      ? "approved"
                      : "required"
                    : "not required"}
                </td>
                <td>
                  {task.requires_approval && !task.approved_at && task.status === "queued" ? (
                    <button
                      className="button-link"
                      onClick={() => {
                        void approveTask(task.id).then(refresh);
                      }}
                    >
                      Approve
                    </button>
                  ) : null}
                  {!["completed", "failed", "cancelled"].includes(task.status) ? (
                    <button
                      className="button-link"
                      onClick={() => {
                        void cancelTask(task.id).then(refresh);
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
        <h2>Runs</h2>
        <table className="grid-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Status</th>
              <th>Task</th>
              <th>Score</th>
              <th>Proof</th>
            </tr>
          </thead>
          <tbody>
            {sortedRuns.map((run) => (
              <tr key={run.id}>
                <td>
                  <Link to={`/runs/${run.id}`} className="mono">
                    {run.id}
                  </Link>
                </td>
                <td>{run.status}</td>
                <td className="mono">{run.task_id}</td>
                <td>{run.score ?? "-"}</td>
                <td>
                  <Link to={`/runs/${run.id}#proof`} className="button-link">
                    Open proof
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
