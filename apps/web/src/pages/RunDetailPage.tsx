import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  getRunDetail,
  getRunEvents,
  type ApiRunDetail,
  type ApiRunEvent
} from "../api/control-plane";

export function RunDetailPage() {
  const params = useParams<{ runId: string }>();
  const runId = params.runId ?? "";

  const [detail, setDetail] = useState<ApiRunDetail | null>(null);
  const [events, setEvents] = useState<ApiRunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function refresh() {
      if (!runId) {
        return;
      }

      try {
        const [nextDetail, nextEvents] = await Promise.all([
          getRunDetail(runId),
          getRunEvents(runId)
        ]);
        setDetail(nextDetail);
        setEvents(nextEvents);
        setError(null);
      } catch (refreshError) {
        setError((refreshError as Error).message);
      }
    }

    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 2000);

    return () => clearInterval(timer);
  }, [runId]);

  if (!runId) {
    return <p className="error-banner">Missing run ID.</p>;
  }

  return (
    <div className="content clip-card">
      <header className="content-header">
        <h1>Run Detail</h1>
        <p className="muted mono">{runId}</p>
        <Link to="/" className="button-link">
          Back to control center
        </Link>
      </header>

      {error ? <p className="error-banner">{error}</p> : null}

      {detail ? (
        <>
          <section className="panel">
            <h2>Status</h2>
            <p>
              Run: <strong>{detail.run.status}</strong>
            </p>
            <p>
              Task: <strong>{detail.task.status}</strong>
            </p>
            <p>
              Attempt: <strong>{detail.run.attempt_no}</strong>
            </p>
          </section>

          <section className="panel">
            <h2>Contract</h2>
            <p>
              Contract ID: <span className="mono">{detail.contract.id}</span>
            </p>
            <p>
              Risk: <strong>{detail.contract.risk}</strong>
            </p>
            <pre className="json-block">{JSON.stringify(detail.contract.contract_json, null, 2)}</pre>
          </section>

          <section className="panel">
            <h2>Evaluation</h2>
            {detail.evaluation ? (
              <>
                <p>
                  Outcome: <strong>{detail.evaluation.outcome}</strong>
                </p>
                <p>
                  Score: <strong>{detail.evaluation.score}</strong>
                </p>
                <p>
                  Hard fail reason: {detail.evaluation.hard_fail_reason ?? "none"}
                </p>
                <ul>
                  {detail.evaluation.findings_json.map((finding) => (
                    <li key={finding}>{finding}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="muted">Evaluation pending.</p>
            )}
          </section>

          <section className="panel">
            <h2>Timeline</h2>
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Seq</th>
                  <th>Type</th>
                  <th>Level</th>
                  <th>Payload</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>{event.sequence_no}</td>
                    <td>{event.event_type}</td>
                    <td>{event.level}</td>
                    <td>
                      <pre className="json-inline">{JSON.stringify(event.payload_json, null, 2)}</pre>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="panel">
            <h2>Research Links</h2>
            {detail.research.length === 0 ? (
              <p className="muted">No synthesis documents yet.</p>
            ) : (
              <ul>
                {detail.research.map((doc) => (
                  <li key={doc.id}>
                    <span className="mono">{doc.id}</span> - {doc.title} (confidence {doc.confidence})
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
