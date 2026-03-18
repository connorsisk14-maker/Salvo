import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  approveTask,
  cancelTask,
  createTask,
  forceRestartDaemon,
  getBackupStatus,
  getBudgetOverview,
  getOrchestratorHealth,
  getResearchHealth,
  getTrustTierOverview,
  listRuns,
  listTasks,
  saveBudgetLimit,
  saveTrustTier,
  triggerBackup,
  type ApiBackupStatus,
  type ApiBudgetOverview,
  type ApiDaemonHealth,
  type ApiRestartTarget,
  type ApiRun,
  type ApiTask,
  type ApiTaskPriority,
  type ApiTrustTier,
  type ApiTrustTierOverview
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

function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  }).format(value);
}

function trustTierRowKey(workspaceId: string, agentProfile: string): string {
  return `${workspaceId}:${agentProfile}`;
}

const TRUST_TIER_OPTIONS: ApiTrustTier["trust_tier"][] = [
  "unrestricted",
  "standard",
  "restricted",
  "probation"
];

const TASK_PRIORITY_OPTIONS: Array<{ value: ApiTaskPriority; label: string }> = [
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" }
];

function formatTaskPriority(priority?: ApiTaskPriority | null): string {
  const option = TASK_PRIORITY_OPTIONS.find((entry) => entry.value === priority);
  return option?.label ?? "Medium";
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
  const [budgetOverview, setBudgetOverview] = useState<ApiBudgetOverview | null>(null);
  const [trustTierOverview, setTrustTierOverview] = useState<ApiTrustTierOverview | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [backupSubmitting, setBackupSubmitting] = useState(false);
  const [budgetSubmitting, setBudgetSubmitting] = useState(false);
  const [trustTierSavingKey, setTrustTierSavingKey] = useState<string | null>(null);
  const [restartTarget, setRestartTarget] = useState<ApiRestartTarget | null>(null);
  const [restartMessage, setRestartMessage] = useState<string | null>(null);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [budgetMessage, setBudgetMessage] = useState<string | null>(null);
  const [trustTierMessage, setTrustTierMessage] = useState<string | null>(null);
  const [budgetWorkspaceId, setBudgetWorkspaceId] = useState("");
  const [budgetFamilyKey, setBudgetFamilyKey] = useState("");
  const [budgetLimitUsd, setBudgetLimitUsd] = useState("25");
  const [trustTierEdits, setTrustTierEdits] = useState<Record<string, ApiTrustTier["trust_tier"]>>({});
  const [error, setError] = useState<string | null>(null);
  const [taskPriority, setTaskPriority] = useState<ApiTaskPriority>("medium");

  const sortedRuns = useMemo(
    () => [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [runs]
  );
  const budgetState = useMemo(() => {
    if (!budgetOverview || budgetOverview.budgets.length === 0) {
      return "pending";
    }
    if (budgetOverview.budgets.some((entry) => entry.remaining_usd < 0)) {
      return "error";
    }
    return "healthy";
  }, [budgetOverview]);
  const trustTierState = useMemo(() => {
    if (!trustTierOverview || trustTierOverview.tiers.length === 0) {
      return "pending";
    }
    if (trustTierOverview.tiers.some((entry) => entry.trust_tier === "probation")) {
      return "error";
    }
    return "healthy";
  }, [trustTierOverview]);

  async function refresh() {
    try {
      const [
        nextTasks,
        nextRuns,
        nextOrchestratorHealth,
        nextResearchHealth,
        nextBackupStatus,
        nextBudgetOverview,
        nextTrustTierOverview
      ] =
        await Promise.all([
          listTasks(),
          listRuns(),
          getOrchestratorHealth(),
          getResearchHealth(),
          getBackupStatus(),
          getBudgetOverview(),
          getTrustTierOverview()
        ]);
      setTasks(nextTasks);
      setRuns(nextRuns);
      setOrchestratorHealth(nextOrchestratorHealth);
      setResearchHealth(nextResearchHealth);
      setBackupStatus(nextBackupStatus);
      setBudgetOverview(nextBudgetOverview);
      setTrustTierOverview(nextTrustTierOverview);
      setBudgetWorkspaceId((current) =>
        nextBudgetOverview.workspaces.some((workspace) => workspace.id === current)
          ? current
          : (nextBudgetOverview.workspaces[0]?.id ?? "")
      );
      setTrustTierEdits((current) => {
        const next: Record<string, ApiTrustTier["trust_tier"]> = {};
        for (const tier of nextTrustTierOverview.tiers) {
          const key = trustTierRowKey(tier.workspace_id, tier.agent_profile);
          const existing = current[key];
          next[key] = existing && existing !== tier.trust_tier ? existing : tier.trust_tier;
        }
        return next;
      });
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
        requiresApproval,
        priority: taskPriority
      });
      setRequest("");
      setTaskPriority("medium");
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

  async function onSaveBudget(event: FormEvent) {
    event.preventDefault();
    setBudgetSubmitting(true);
    try {
      const parsedLimit = Number(budgetLimitUsd);
      await saveBudgetLimit({
        workspaceId: budgetWorkspaceId,
        contractFamilyKey: budgetFamilyKey.trim() || undefined,
        limitUsd: parsedLimit
      });
      setBudgetMessage(
        `${budgetFamilyKey.trim() ? "Family" : "Workspace"} budget saved at ${formatUsd(parsedLimit)}.`
      );
      await refresh();
      setError(null);
    } catch (budgetError) {
      setBudgetMessage(`Budget update failed: ${(budgetError as Error).message}`);
    } finally {
      setBudgetSubmitting(false);
    }
  }

  async function onSaveTrustTier(tier: ApiTrustTier) {
    const key = trustTierRowKey(tier.workspace_id, tier.agent_profile);
    const trustTier = trustTierEdits[key] ?? tier.trust_tier;

    setTrustTierSavingKey(key);
    try {
      await saveTrustTier({
        workspaceId: tier.workspace_id,
        agentProfile: tier.agent_profile,
        trustTier
      });
      setTrustTierMessage(
        `${tier.workspace_name} ${tier.agent_profile} trust tier set to ${trustTier}.`
      );
      setTrustTierEdits((current) => ({
        ...current,
        [key]: trustTier
      }));
      await refresh();
      setError(null);
    } catch (trustTierError) {
      setTrustTierMessage(`Trust tier update failed: ${(trustTierError as Error).message}`);
    } finally {
      setTrustTierSavingKey(null);
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
            <p className="muted">
              Capacity: {(orchestratorHealth?.metadata?.max_concurrent_runs as number | undefined) ?? "-"}
            </p>
            <p className="muted">
              Available slots: {(orchestratorHealth?.metadata?.available_runner_slots as number | undefined) ?? "-"}
            </p>
            <p className="muted">
              Queue depth: {(orchestratorHealth?.metadata?.queue_depth as number | undefined) ?? "-"}
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
        <div className="health-card-head">
          <h2>Budgets</h2>
          <span className={`status-pill status-${budgetState}`}>{budgetState}</span>
        </div>
        <div className="health-grid">
          <article className="health-card">
            <h3>Coverage</h3>
            <p className="muted">Configured caps: {budgetOverview?.budgets.length ?? 0}</p>
            <p className="muted">Workspaces: {budgetOverview?.workspaces.length ?? 0}</p>
            <p className="muted">
              Over limit:{" "}
              {budgetOverview?.budgets.filter((entry) => entry.remaining_usd < 0).length ?? 0}
            </p>
          </article>

          <article className="health-card">
            <h3>Add Or Update Limit</h3>
            <form className="form-grid" onSubmit={onSaveBudget}>
              <label>
                Workspace
                <select
                  value={budgetWorkspaceId}
                  onChange={(event) => setBudgetWorkspaceId(event.target.value)}
                  required
                >
                  {(budgetOverview?.workspaces ?? []).map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Contract Family Key
                <input
                  placeholder="Leave blank for workspace-wide cap"
                  value={budgetFamilyKey}
                  onChange={(event) => setBudgetFamilyKey(event.target.value)}
                />
              </label>
              <label>
                Limit (USD)
                <input
                  min="0"
                  onChange={(event) => setBudgetLimitUsd(event.target.value)}
                  required
                  step="0.01"
                  type="number"
                  value={budgetLimitUsd}
                />
              </label>
              <button
                className="button-link"
                disabled={budgetSubmitting || budgetWorkspaceId.length === 0}
                type="submit"
              >
                {budgetSubmitting ? "Saving..." : "Save budget limit"}
              </button>
            </form>
            {budgetMessage ? <p className="muted restart-note">{budgetMessage}</p> : null}
          </article>
        </div>

        <table className="grid-table">
          <thead>
            <tr>
              <th>Scope</th>
              <th>Workspace</th>
              <th>Family</th>
              <th>Limit</th>
              <th>Spend</th>
              <th>Remaining</th>
              <th>Last Usage</th>
            </tr>
          </thead>
          <tbody>
            {(budgetOverview?.budgets ?? []).map((budget) => (
              <tr key={budget.id}>
                <td>{budget.scope}</td>
                <td>{budget.workspace_name}</td>
                <td className="mono">{budget.contract_family_key ?? "-"}</td>
                <td className="mono">{formatUsd(budget.limit_usd)}</td>
                <td className="mono">{formatUsd(budget.spent_usd)}</td>
                <td className="mono">{formatUsd(budget.remaining_usd)}</td>
                <td>{renderDateTime(budget.last_usage_at)}</td>
              </tr>
            ))}
            {budgetOverview?.budgets.length ? null : (
              <tr>
                <td colSpan={7} className="muted">
                  No budget caps configured yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <div className="health-card-head">
          <h2>Trust Tiers</h2>
          <span className={`status-pill status-${trustTierState}`}>{trustTierState}</span>
        </div>
        <div className="health-grid">
          <article className="health-card">
            <h3>Coverage</h3>
            <p className="muted">Tracked profiles: {trustTierOverview?.tiers.length ?? 0}</p>
            <p className="muted">Manual overrides: {trustTierOverview?.tiers.filter((entry) => entry.managed_by === "manual").length ?? 0}</p>
            <p className="muted">Probation: {trustTierOverview?.tiers.filter((entry) => entry.trust_tier === "probation").length ?? 0}</p>
          </article>

          <article className="health-card">
            <h3>Policy Notes</h3>
            <p className="muted">Probation requires manual review and clamps runtime plus tool-call budget.</p>
            <p className="muted">System-managed restricted agents auto-promote after three successful runs.</p>
            <p className="muted">Manual overrides stop automatic promotion until the row is set back by an operator.</p>
          </article>
        </div>
        {trustTierMessage ? <p className="muted restart-note">{trustTierMessage}</p> : null}

        <table className="grid-table">
          <thead>
            <tr>
              <th>Workspace</th>
              <th>Profile</th>
              <th>Tier</th>
              <th>Managed By</th>
              <th>Successful Runs</th>
              <th>Last Run</th>
              <th>Promoted</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(trustTierOverview?.tiers ?? []).map((tier) => {
              const key = trustTierRowKey(tier.workspace_id, tier.agent_profile);
              const selectedTier = trustTierEdits[key] ?? tier.trust_tier;
              const dirty = selectedTier !== tier.trust_tier;

              return (
                <tr key={key}>
                  <td>{tier.workspace_name}</td>
                  <td>{tier.agent_profile}</td>
                  <td>
                    <select
                      value={selectedTier}
                      onChange={(event) =>
                        setTrustTierEdits((current) => ({
                          ...current,
                          [key]: event.target.value as ApiTrustTier["trust_tier"]
                        }))
                      }
                    >
                      {TRUST_TIER_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{tier.managed_by}</td>
                  <td>{tier.successful_runs}</td>
                  <td>{renderDateTime(tier.last_run_at)}</td>
                  <td>{renderDateTime(tier.promoted_at)}</td>
                  <td>
                    <button
                      className="button-link"
                      disabled={!dirty || trustTierSavingKey === key}
                      onClick={() => {
                        void onSaveTrustTier(tier);
                      }}
                      type="button"
                    >
                      {trustTierSavingKey === key ? "Saving..." : "Save"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {trustTierOverview?.tiers.length ? null : (
              <tr>
                <td colSpan={8} className="muted">
                  No trust tier data available yet.
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
          <label>
            Queue priority
            <select
              value={taskPriority}
              onChange={(event) => setTaskPriority(event.target.value as ApiTaskPriority)}
            >
              {TASK_PRIORITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <small className="muted">Urgent tasks are claimed before high, medium, and low work.</small>
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
              <th>Priority</th>
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
                <td>{formatTaskPriority(task.priority)}</td>
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
