import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  approveTask,
  cancelTask,
  createTask,
  forceRestartDaemon,
  getBackupStatus,
  getOrchestratorHealth,
  getResearchHealth,
  listRuns,
  listTasks,
  triggerBackup,
  type ApiBackupStatus,
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

function renderDateTime(value?: string | null): string {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString();
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
  const [backupStatus, setBackupStatus] = useState<ApiBackupStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [backupSubmitting, setBackupSubmitting] = useState(false);
  const [restartTarget, setRestartTarget] = useState<ApiRestartTarget | null>(null);
  const [restartMessage, setRestartMessage] = useState<string | null>(null);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sortedRuns = useMemo(
    () => [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [runs]
  );

  async function refresh() {
    try {
      const [nextTasks, nextRuns, nextOrchestratorHealth, nextResearchHealth, nextBackupStatus] =
        await Promise.all([
          listTasks(),
          listRuns(),
          getOrchestratorHealth(),
          getResearchHealth(),
          getBackupStatus()
        ]);
      setTasks(nextTasks);
      setRuns(nextRuns);
      setOrchestratorHealth(nextOrchestratorHealth);
      setResearchHealth(nextResearchHealth);
      setBackupStatus(nextBackupStatus);
      setError(null);
    } catch (refreshError) {
      setError((refreshError as Error).message);
    }
  }

  useEffect(() => {
    void refresh();
    const intervalId = window.setInterval(() => {
      void refresh();
    }, 1500);

    return () => {
      window.clearInterval(intervalId);
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

  async function onTriggerBackup() {
    setBackupSubmitting(true);
    try {
      const response = await triggerBackup();
      if (!response.ok || !response.result) {
        throw new Error(response.error ?? "Backup trigger failed.");
      }

      setBackupMessage(
        `Backup verified at ${renderDateTime(response.result.completed_at)} (${response.result.backup?.size_bytes ?? 0} bytes).`
      );
      await refresh();
    } catch (backupError) {
      setBackupMessage(`Backup failed: ${(backupError as Error).message}`);
    } finally {
      setBackupSubmitting(false);
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
        <div className="health-card-head">
          <h2>Backups</h2>
          <span className={`status-pill status-${backupStatus?.state ?? "pending"}`}>
            {backupStatus?.state ?? "pending"}
          </span>
        </div>
        <div className="backup-grid">
          <article className="health-card">
            <h3>Schedule</h3>
            <p className="muted">Storage: <span className="mono">{backupStatus?.storage_dir ?? "-"}</span></p>
            <p className="muted">Next run: {renderDateTime(backupStatus?.next_scheduled_at)}</p>
            <p className="muted">
              Retention: {backupStatus?.retention.daily ?? "-"} daily / {backupStatus?.retention.weekly ?? "-"} weekly
            </p>
            <p className="muted">Hour: {backupStatus?.schedule_hour_local ?? "-"}:00 local</p>
          </article>

          <article className="health-card">
            <h3>Latest Result</h3>
            <p className="muted">Started: {renderDateTime(backupStatus?.last_run?.started_at)}</p>
            <p className="muted">Completed: {renderDateTime(backupStatus?.last_run?.completed_at)}</p>
            <p className="muted">Trigger: {backupStatus?.last_run?.trigger ?? "-"}</p>
            <p className="muted">
              Archive: <span className="mono">{backupStatus?.last_run?.backup?.file_name ?? "-"}</span>
            </p>
            <p className="muted">
              Error: {backupStatus?.last_run?.success === false ? backupStatus.last_run.error : "-"}
            </p>
          </article>
        </div>
        <div className="backup-actions">
          <button
            className="button-link"
            disabled={backupSubmitting || backupStatus?.state === "running"}
            onClick={() => {
              void onTriggerBackup();
            }}
            type="button"
          >
            {backupSubmitting ? "Running backup..." : "Run backup now"}
          </button>
          {backupStatus?.running ? (
            <p className="muted">
              Running: {backupStatus.running.trigger} by pid {backupStatus.running.pid} since{" "}
              {renderDateTime(backupStatus.running.started_at)}
            </p>
          ) : null}
          {backupMessage ? <p className="muted restart-note">{backupMessage}</p> : null}
        </div>

        <table className="grid-table">
          <thead>
            <tr>
              <th>Backup</th>
              <th>Created</th>
              <th>Verified</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {(backupStatus?.recent_backups ?? []).map((backup) => (
              <tr key={backup.path}>
                <td className="mono">{backup.file_name}</td>
                <td>{renderDateTime(backup.created_at)}</td>
                <td>{renderDateTime(backup.verified_at)}</td>
                <td>{backup.size_bytes.toLocaleString()} bytes</td>
              </tr>
            ))}
            {backupStatus?.recent_backups.length ? null : (
              <tr>
                <td colSpan={4} className="muted">
                  No backups recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
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
