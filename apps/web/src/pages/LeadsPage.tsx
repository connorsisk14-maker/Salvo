import { useEffect, useState } from "react";
import { getLeadsOverview, type ApiLeadsOverview } from "../api/control-plane";

function formatTimestamp(value?: string | null): string {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString([], { hour12: true });
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) {
    return "—";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function describeRowContext(rowContext?: Record<string, unknown> | null): string {
  if (!rowContext) {
    return "Row context not captured.";
  }
  const entries = Object.entries(rowContext);
  if (entries.length === 0) {
    return "Row context captured but empty.";
  }
  const summary = entries
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${describeRowValue(value)}`)
    .join(" · ");
  if (entries.length > 3) {
    return `${summary} · +${entries.length - 3} more`;
  }
  return summary;
}

function describeRowValue(value: unknown): string {
  if (typeof value === "string") {
    return value.length <= 60 ? value : `${value.slice(0, 57)}…`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length} items]`;
  }
  if (value === null || value === undefined) {
    return "—";
  }
  return "{…}";
}

export function LeadsPage() {
  const [overview, setOverview] = useState<ApiLeadsOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await getLeadsOverview();
      setOverview(payload);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadOverview();
  }, []);

  const sheetUrl = overview?.sheet_url;
  const zones = overview?.zones ?? [];
  const runs = overview?.runs ?? [];
  const funnel = overview?.funnel ?? [];

  return (
    <section className="content clip-card leads-page">
      <header className="content-header leads-page-header">
        <div>
          <h1>Lead Pipeline</h1>
          <p className="muted">
            Track DFW funnel health, zone completion, and the latest scraper/strategist activity.
          </p>
        </div>
        <div className="leads-page-actions">
          {sheetUrl ? (
            <a className="button-link" href={sheetUrl} target="_blank" rel="noreferrer">
              Open Google Sheet
            </a>
          ) : (
            <span className="muted">Set SALVO_LEAD_PIPELINE_SHEET_ID to show the sheet link.</span>
          )}
          <button className="button-link" type="button" onClick={loadOverview} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>
      {overview?.updated_at ? (
        <p className="muted">Last update: {formatTimestamp(overview.updated_at)}</p>
      ) : null}
      {error ? <p className="error-banner">{error}</p> : null}

      <div className="leads-funnel-grid">
        {funnel.map((item) => (
          <article className="funnel-card" key={item.id}>
            <div className="funnel-card-value">{item.count.toLocaleString()}</div>
            <p className="funnel-card-label">{item.label}</p>
            <p className="muted">{item.detail}</p>
          </article>
        ))}
        {loading && funnel.length === 0 ? <p className="muted">Loading funnel data…</p> : null}
      </div>

      <div className="lead-zones-grid">
        {zones.map((zone) => (
          <article className="lead-zone-card" key={zone.name}>
            <header className="lead-zone-card-header">
              <div>
                <h3>{zone.name}</h3>
                <p className="muted">
                  Priority {zone.priority} · {zone.focus}
                </p>
              </div>
              <span className="lead-zone-status">{zone.status}</span>
            </header>
            <div className="lead-progress-bar">
              <span className="lead-progress-fill" style={{ width: `${zone.progress}%` }} />
            </div>
            <div className="lead-zone-meta">
              <div>
                <span className="label">Progress</span>
                <span className="value">{zone.progress}%</span>
              </div>
              <div>
                <span className="label">Scrapes this week</span>
                <span className="value">{zone.scrapes_this_week}</span>
              </div>
              <div>
                <span className="label">Last update</span>
                <span className="value">{formatTimestamp(zone.last_updated_at)}</span>
              </div>
            </div>
          </article>
        ))}
        {zones.length === 0 && !loading ? (
          <p className="muted">No zone data yet.</p>
        ) : null}
      </div>

      <section className="lead-runs-section">
        <header className="board-section-head">
          <h2>Recent scraper & strategist runs</h2>
        </header>
        <div className="lead-runs-grid">
          {runs.map((run) => (
            <article className="lead-run-card" key={run.id}>
              <div className="lead-run-card-heading">
                <span className="mono">{run.id.slice(-8)}</span>
                <span className={`status-pill status-pill-${run.status}`}>{run.status}</span>
              </div>
              <p className="muted">
                {run.agent_profile} · {run.contract_family_key}
              </p>
            <div className="lead-run-meta">
              <div>
                <span className="label">Created</span>
                <span className="value">{formatTimestamp(run.created_at)}</span>
              </div>
              <div>
                <span className="label">Duration</span>
                <span className="value">{formatDuration(run.duration_seconds)}</span>
              </div>
              <div>
                <span className="label">Score</span>
                <span className="value">{run.score ?? "—"}</span>
              </div>
            </div>
            {run.lead_chain ? (
              <div className="lead-run-chain">
                <p className="lead-run-chain-summary">
                  {run.lead_chain.row_context
                    ? describeRowContext(run.lead_chain.row_context)
                    : "Row context pending…"}
                </p>
                <div className="lead-run-chain-meta">
                  <span className="label">
                    {run.lead_chain.strategist_run_id ? "Strategist run" : "Strategist task"}
                  </span>
                  <span className="value mono">
                    {run.lead_chain.strategist_run_id ?? run.lead_chain.strategist_task_id ?? "pending"}
                  </span>
                </div>
              </div>
            ) : null}
            {run.outcome_summary ? <p className="muted">{run.outcome_summary}</p> : null}
          </article>
        ))}
        </div>
        {runs.length === 0 && !loading ? <p className="muted">No recent runs yet.</p> : null}
      </section>
    </section>
  );
}
