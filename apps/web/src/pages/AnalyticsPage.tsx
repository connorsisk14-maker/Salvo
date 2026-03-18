import { useEffect, useMemo, useState } from "react";
import { fetchAnalyticsCost, type ApiCostAnalytics } from "../api/control-plane";

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

export function AnalyticsPage() {
  const [data, setData] = useState<ApiCostAnalytics | null>(null);
  const [fromDate, setFromDate] = useState(defaultFromIso);
  const [toDate, setToDate] = useState(todayIso);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchData = () => {
    setLoading(true);
    setError(null);
    fetchAnalyticsCost({ from: fromDate, to: toDate })
      .then((payload) => {
        setData(payload);
      })
      .catch((requestError) => {
        setError((requestError as Error).message);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchData();
  }, [fromDate, toDate, refreshKey]);

  const dayBars = useMemo(() => {
    if (!data) {
      return [];
    }
    const maxCost = Math.max(...data.byDay.map((entry) => entry.costUsd), 1);
    return data.byDay.map((row) => ({
      ...row,
      width: Math.min(100, (row.costUsd / maxCost) * 100)
    }));
  }, [data]);

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
                {data ? formatCost(data.summary.totalCostUsd) : "–"}
              </p>
              <p className="muted">{data ? `${data.summary.runCount} runs` : "Runs pending"}</p>
            </article>
            <article className="analytics-card">
              <h2>Avg. Run Cost</h2>
              <p className="analytics-value">{data ? formatCost(data.summary.averageCostUsd) : "–"}</p>
              <p className="muted">Updated {data?.summary.lastEventAt ?? "—"}</p>
            </article>
            <article className="analytics-card">
              <h2>Cost Range</h2>
              <p className="analytics-value">
                {data
                  ? `${formatCost(data.summary.averageCostUsd)} avg | ${formatCost(data.summary.totalCostUsd / Math.max(data.summary.runCount, 1))} per run`
                  : "–"}
              </p>
              <p className="muted">
                {data?.summary.firstEventAt ? `First event ${data.summary.firstEventAt}` : "No events yet"}
              </p>
            </article>
          </div>

          <div className="analytics-grid">
            <article className="analytics-card chart-card">
              <header>
                <h3>Daily Costs</h3>
              </header>
              <div className="analytics-chart">
                {dayBars.length === 0 ? (
                  <p className="muted">No data for this range.</p>
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
              <ul className="analytics-list">
                {(data?.byModel ?? []).map((entry) => (
                  <li key={entry.label}>
                    <span>{entry.label}</span>
                    <span>{formatCost(entry.costUsd)}</span>
                  </li>
                ))}
              </ul>
            </article>
            <article className="analytics-card">
              <h3>Cost by Agent Profile</h3>
              <ul className="analytics-list">
                {(data?.byAgentProfile ?? []).map((entry) => (
                  <li key={entry.label}>
                    <span>{entry.label}</span>
                    <span>{formatCost(entry.costUsd)}</span>
                  </li>
                ))}
              </ul>
            </article>
            <article className="analytics-card">
              <h3>Cost by Category</h3>
              <ul className="analytics-list">
                {(data?.byCategory ?? []).map((entry) => (
                  <li key={entry.label}>
                    <span>{entry.label}</span>
                    <span>{formatCost(entry.costUsd)}</span>
                  </li>
                ))}
              </ul>
            </article>
          </div>
        </>
      )}
    </section>
  );
}
