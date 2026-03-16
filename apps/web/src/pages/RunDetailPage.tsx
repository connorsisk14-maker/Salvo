import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  getArtifactPreview,
  getArtifactContentObjectUrl,
  getRunDetail,
  getRunEvents,
  openArtifactContent,
  type ApiArtifactPreview,
  type ApiRunDetail,
  type ApiRunEvent
} from "../api/control-plane";

export function RunDetailPage() {
  const params = useParams<{ runId: string }>();
  const runId = params.runId ?? "";

  const [detail, setDetail] = useState<ApiRunDetail | null>(null);
  const [events, setEvents] = useState<ApiRunEvent[]>([]);
  const [artifactPreviews, setArtifactPreviews] = useState<Record<string, ApiArtifactPreview>>({});
  const [artifactContentUrls, setArtifactContentUrls] = useState<Record<string, string>>({});
  const [previewBusy, setPreviewBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const artifactContentUrlsRef = useRef<Record<string, string>>({});

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

  async function loadArtifactPreview(artifactId: string) {
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
    } catch (previewError) {
      setError((previewError as Error).message);
    } finally {
      setPreviewBusy((current) => ({
        ...current,
        [artifactId]: false
      }));
    }
  }

  useEffect(() => {
    setArtifactPreviews({});
    setArtifactContentUrls({});
    setPreviewBusy({});

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
    const intervalId = window.setInterval(() => {
      void refresh();
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [runId]);

  async function onOpenArtifact(artifactId: string) {
    try {
      await openArtifactContent(artifactId);
      setError(null);
    } catch (artifactError) {
      setError((artifactError as Error).message);
    }
  }

  if (!runId) {
    return <p className="error-banner">Missing run ID.</p>;
  }

  return (
    <div className="content clip-card">
      <header className="content-header">
        <h1>Run Detail</h1>
        <p className="muted mono">{runId}</p>
        <div>
          <Link to="/" className="button-link">
            Back to control center
          </Link>
          {" "}
          <Link to="/board" className="button-link">
            Open board
          </Link>
        </div>
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

          <section id="proof" className="panel">
            <h2>Proof of Work</h2>
            <p className="muted">
              Artifact records and final payload evidence for this run.
            </p>

            {detail.artifacts.length === 0 ? (
              <p className="muted">No artifacts recorded.</p>
            ) : (
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>Artifact</th>
                    <th>Path</th>
                    <th>Created</th>
                    <th>Preview</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.artifacts.map((artifact) => (
                    <tr key={artifact.id}>
                      <td>{artifact.artifact_type}</td>
                      <td className="mono">{artifact.path}</td>
                      <td>{new Date(artifact.created_at).toLocaleString()}</td>
                      <td>
                        <button
                          type="button"
                          className="button-link"
                          onClick={() => {
                            void onOpenArtifact(artifact.id);
                          }}
                        >
                          Open file
                        </button>
                        {" "}
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
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {detail.artifacts.map((artifact) => {
              const preview = artifactPreviews[artifact.id];
              if (!preview) {
                return null;
              }

              return (
                <article className="proof-preview-card" key={`preview-${artifact.id}`}>
                  <h3>{artifact.artifact_type} preview</h3>
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
                    <p className="muted">
                      Binary artifact. Use Open file to inspect.
                    </p>
                  ) : null}
                </article>
              );
            })}

            <h3>Final Payload</h3>
            {detail.final_payload ? (
              <pre className="json-block">{JSON.stringify(detail.final_payload, null, 2)}</pre>
            ) : (
              <p className="muted">Final payload not available.</p>
            )}
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
