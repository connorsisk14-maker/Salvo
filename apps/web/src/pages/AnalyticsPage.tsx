import { useEffect, useMemo, useState } from "react";
import {
  fetchAnalyticsCost,
  getRunEvents,
  listRuns,
  type ApiCostAnalytics,
  type ApiRun
} from "../api/control-plane";

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const CURRENCY = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 });

function todayIso(): string {
  return new Date().toISOString().split("T")[0];
}

function defaultFromIso(): string {
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return from.toISOString().split("T")[0];
}

function formatCost(cost: number): string {
  return CURRENCY.format(cost);
}

function formatDateTime(value?: string | null): string {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString();
}

const RUN_STATUS_ORDER: Array<ApiRun["status"]> = [
  "created",
  "provisioning",
  "starting",
  "running",
  "evaluating",
  "completed",
  "failed",
  "blocked",
  "cancelled"
];

const MAX_EVENT_RUNS = 8;

export function AnalyticsPage() {
  const [costData, setCostData] = useState<ApiCostAnalytics | null>(null);
  const [runs, setRuns] = useState<ApiRun[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [fromDate, setFromDate] = useState(defaultFromIso);
  const [toDate, setToDate] = useState(todayIso);
  const [loading, setLoading] = useState(false);
  const [eventLoading, setEventLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventVolume, setEventVolume] = useState<Record<string, number>>({});
  const [eventsPerRun, setEventsPerRun] = useState<Record<string, number>>({});
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchData = () => {
    setLoading(true);
    setError(null);
    Promise.all([fetchAnalyticsCost({ from: fromDate, to: toDate }), listRuns()])
      .then(([payload, runList]) => {
        setCostData(payload);
        setRuns(runList);
        setHasLoaded(true);
      })
      .catch((requestError) => {
        setError((requestError as Error).message);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchData();
  }, [fromDate, toDate, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    if (runs.length === 0) {
      setEventVolume({});
      setEventsPerRun({});
      setEventLoading(false);
      return;
    }

    const limitedRuns = runs.slice(0, MAX_EVENT_RUNS);
    setEventLoading(true);

    const loadEvents = async () => {
      try {
        const responses = await Promise.all(limitedRuns.map((run) => getRunEvents(run.id)));
        if (cancelled) {
          return;
        }

        const volumeAccumulator: Record<string, number> = {};
        const perRunAccumulator: Record<string, number> = {};
        responses.forEach((events, index) => {
          const runId = limitedRuns[index].id;
          perRunAccumulator[runId] = events.length;
          for (const event of events) {
            volumeAccumulator[event.event_type] = (volumeAccumulator[event.event_type] ?? 0) + 1;
          }
        });

        setEventVolume(volumeAccumulator);
        setEventsPerRun(perRunAccumulator);
      } catch {
        if (!cancelled) {
          setEventVolume({});
          setEventsPerRun({});
        }
      } finally {
        if (!cancelled) {
          setEventLoading(false);
        }
      }
    };

    void loadEvents();
    return () => {
      cancelled = true;
    };
  }, [runs]);

  const statusBreakdown = useMemo(() => {
    const counts: Record<string, number> = {};
    runs.forEach((run) => {
      counts[run.status] = (counts[run.status] ?? 0) + 1;
    });
    return RUN_STATUS_ORDER.map((status) => ({
      status,
      count: counts[status] ?? 0
    })).filter((entry) => entry.count > 0);
  }, [runs]);

  const failureBreakdown = useMemo(() => {
    const counts: Record<string, number> = {};
    runs.forEach((run) => {
      const reason = run.exit_reason?.trim();
      if (run.status === "failed" || (reason && reason.length > 0)) {
        const normalized = reason && reason.length > 0 ? reason : "unknown";
        counts[normalized] = (counts[normalized] ?? 0) + 1;
      }
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [runs]);

  const eventVolumeEntries = useMemo(() => {
    const entries = Object.entries(eventVolume);
    entries.sort((a, b) => b[1] - a[1]);
    return entries;
  }, [eventVolume]);

  const totalEventCount = useMemo(
    () => eventVolumeEntries.reduce((sum, [, count]) => sum + count, 0),
    [eventVolumeEntries]
  );

  const recentRuns = useMemo(() => runs.slice(0, 6), [runs]);

  const dayBars = useMemo(() => {
    if (!costData) {
      return [];
    }
    const maxCost = Math.max(...costData.byDay.map((entry) => entry.costUsd), 1);
    return costData.byDay.map((row) => ({
      ...row,
      width: Math.min(100, (row.costUsd / maxCost) * 100)
    }));
  }, [costData]);

  return (
    <section className="content clip-card analytics-page">
      <header className="content-header">
        <h1>Cost Analytics</h1>
        <p className="muted">Roll up the usage reported events into daily, model, agent, and category summaries.</p>
      </header>

      <div className="analytics-controls">
        <label>
          From
          <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
        </label>
        <button className="button-link" type="button" onClick={() => setRefreshKey((key) => key + 1)} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error ? (
        <p className="error-banner">{error}</p>
      ) : (
        <>
          <div className="analytics-grid summary-grid">
            <article className="analytics-card">
              <h2>Total Spend</h2>
              <p className="analytics-value">
                {costData ? formatCost(costData.summary.totalCostUsd) : "–"}
              </p>
              <p className="muted">{costData ? `${costData.summary.runCount} runs` : "Runs pending"}</p>
            </article>
            <article className="analytics-card">
              <h2>Avg. Run Cost</h2>
              <p className="analytics-value">
                {costData ? formatCost(costData.summary.averageCostUsd) : "–"}
              </p>
              <p className="muted">Updated {costData?.summary.lastEventAt ?? "—"}</p>
            </article>
            <article className="analytics-card">
              <h2>Cost Range</h2>
              <p className="analytics-value">
                {costData
                  ? `${formatCost(costData.summary.averageCostUsd)} avg | ${formatCost(
                      costData.summary.totalCostUsd / Math.max(costData.summary.runCount, 1)
                    )} per run`
                  : "–"}
              </p>
              <p className="muted">
                {costData?.summary.firstEventAt ? `First event ${costData.summary.firstEventAt}` : "No events yet"}
              </p>
            </article>
          </div>

          <div className="analytics-grid">
            <article className="analytics-card">
              <h3>Run health</h3>
              {statusBreakdown.length === 0 ? (
                <p className="muted">Waiting for run data.</p>
              ) : (
                <ul className="analytics-list">
                  {statusBreakdown.map((entry) => (
                    <li key={entry.status}>
                      <span>{entry.status}</span>
                      <span className="status-pill">{entry.count}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="muted">Last {runs.length} runs inspected.</p>
            </article>
            <article className="analytics-card">
              <h3>Failure reasons</h3>
              {failureBreakdown.length === 0 ? (
                <p className="muted">No recent errors.</p>
              ) : (
                <ul className="analytics-list">
                  {failureBreakdown.map(([reason, count]) => (
                    <li key={reason}>
                      <span>{reason}</span>
                      <span className="status-pill">{count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          </div>

          <div className="analytics-grid">
            <article className="analytics-card">
              <h3>
                Event volume (last {Math.min(MAX_EVENT_RUNS, runs.length)} runs)
                {totalEventCount ? ` · ${totalEventCount} events` : ""}
              </h3>
              {eventLoading ? (
                <p className="muted">Gathering event streams…</p>
              ) : eventVolumeEntries.length === 0 ? (
                <p className="muted">No streaming events captured yet.</p>
              ) : (
                <ul className="analytics-list">
                  {eventVolumeEntries.map(([eventType, count]) => (
                    <li key={eventType}>
                      <span>{eventType}</span>
                      <span className="muted">{count} events</span>
                    </li>
                  ))}
                </ul>
              )}
            </article>

            <article className="analytics-card">
              <h3>Recent activity</h3>
              <div style={{ overflowX: "auto" }}>
                <table className="grid-table">
                  <thead>
                    <tr>
                      <th>Created</th>
                      <th>Agent</th>
                      <th>Status</th>
                      <th>Exit reason</th>
                      <th>Events</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentRuns.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="muted">
                          No recent runs.
                        </td>
                      </tr>
                    ) : (
                      recentRuns.map((run) => (
                        <tr key={run.id}>
                          <td>{formatDateTime(run.created_at)}</td>
                          <td>{run.agent_profile}</td>
                          <td>
                            <span className="status-pill">{run.status}</span>
                          </td>
                          <td>{run.exit_reason ?? run.evaluation_outcome ?? "-"}</td>
                          <td>{eventsPerRun[run.id] ?? 0}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </article>
          </div>

          <div className="analytics-grid">
            <article className="analytics-card chart-card">
              <header>
                <h3>Daily Costs</h3>
              </header>
              <div className="analytics-chart">
                {!hasLoaded ? (
                  <>
                    <div className="skeleton skeleton-card" style={{ width: "100%" }} />
                    <div className="skeleton skeleton-card" style={{ width: "100%" }} />
                    <div className="skeleton skeleton-card" style={{ width: "100%" }} />
                  </>
                ) : dayBars.length === 0 ? (
                  <div className="empty-state">No cost data for this period.</div>
                ) : (
                  dayBars.map((row) => (
                    <div key={row.date} className="analytics-row">
                      <span>{DATE_FORMAT.format(new Date(row.date))}</span>
                      <div className="analytics-bar">
                        <div style={{ width: `${row.width}%` }} />
                      </div>
                      <span>{formatCost(row.costUsd)}</span>
                    </div>
                  ))
                )}
              </div>
            </article>

            <article className="analytics-card">
              <h3>Cost by Model</h3>
              {!hasLoaded ? (
                <>
                  <div className="skeleton skeleton-line" style={{ width: "100%" }} />
                  <div className="skeleton skeleton-line" style={{ width: "100%" }} />
                </>
              ) : (costData?.byModel ?? []).length === 0 ? (
                <div className="empty-state">No cost data for this period.</div>
              ) : (
                <ul className="analytics-list">
                  {(costData?.byModel ?? []).map((entry) => (
                    <li key={entry.label}>
                      <span>{entry.label}</span>
                      <span>{formatCost(entry.costUsd)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
            <article className="analytics-card">
              <h3>Cost by Agent Profile</h3>
              {!hasLoaded ? (
                <>
                  <div className="skeleton skeleton-line" style={{ width: "100%" }} />
                  <div className="skeleton skeleton-line" style={{ width: "100%" }} />
                </>
              ) : (costData?.byAgentProfile ?? []).length === 0 ? (
                <div className="empty-state">No cost data for this period.</div>
              ) : (
                <ul className="analytics-list">
                  {(costData?.byAgentProfile ?? []).map((entry) => (
                    <li key={entry.label}>
                      <span>{entry.label}</span>
                      <span>{formatCost(entry.costUsd)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
            <article className="analytics-card">
              <h3>Cost by Category</h3>
              {!hasLoaded ? (
                <>
                  <div className="skeleton skeleton-line" style={{ width: "100%" }} />
                  <div className="skeleton skeleton-line" style={{ width: "100%" }} />
                </>
              ) : (costData?.byCategory ?? []).length === 0 ? (
                <div className="empty-state">No cost data for this period.</div>
              ) : (
                <ul className="analytics-list">
                  {(costData?.byCategory ?? []).map((entry) => (
                    <li key={entry.label}>
                      <span>{entry.label}</span>
                      <span>{formatCost(entry.costUsd)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          </div>
        </>
      )}
    </section>
  );
}
