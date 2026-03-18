import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  getArtifactPreview,
  getArtifactContentObjectUrl,
  getRunDetail,
  getRunEvents,
  openArtifactContent,
  createRunEventStream,
  type ApiArtifactPreview,
  type ApiRunDetail,
  type ApiRunEvent
} from "../api/control-plane";

export function RunDetailPage() {
  const params = useParams<{ runId: string }>();
  const runId = params.runId ?? "";

  const [detail, setDetail] = useState<ApiRunDetail | null>(null);
  const [events, setEvents] = useState<ApiRunEvent[]>([]);
  const [streamActive, setStreamActive] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [artifactPreviews, setArtifactPreviews] = useState<Record<string, ApiArtifactPreview>>({});
  const [artifactContentUrls, setArtifactContentUrls] = useState<Record<string, string>>({});
  const [previewBusy, setPreviewBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const artifactContentUrlsRef = useRef<Record<string, string>>({});
  const streamRef = useRef<EventSource | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const lastSequenceRef = useRef<number | null>(null);
  const detailRef = useRef<ApiRunDetail | null>(null);

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
    detailRef.current = detail;
  }, [detail]);

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
    setEvents([]);
    setDetail(null);
    lastSequenceRef.current = null;
    setStreamError(null);
    setStreamActive(false);

    if (!runId) {
      setError(null);
      return;
    }

    let active = true;

    async function refreshSnapshot() {
      try {
        const [nextDetail, nextEvents] = await Promise.all([
          getRunDetail(runId),
          getRunEvents(runId)
        ]);
        if (!active) {
          return;
        }
        setDetail(nextDetail);
        setEvents(nextEvents);
        lastSequenceRef.current = nextEvents[nextEvents.length - 1]?.sequence_no ?? null;
        setError(null);
      } catch (snapshotError) {
        if (!active) {
          return;
        }
        setError((snapshotError as Error).message);
      }
    }

    void refreshSnapshot();

    return () => {
      active = false;
    };
  }, [runId]);

  useEffect(() => {
    if (!runId) {
      streamRef.current?.close();
      streamRef.current = null;
      setStreamActive(false);
      return;
    }

    let active = true;
    const source = createRunEventStream(runId);
    streamRef.current = source;
    setStreamActive(false);
    setStreamError(null);

    const handleOpen = () => {
      if (!active) {
        return;
      }
      setStreamActive(true);
    };

    const refreshEvents = async () => {
      try {
        const nextEvents = await getRunEvents(runId);
        if (!active) {
          return;
        }
        setEvents(nextEvents);
        lastSequenceRef.current = nextEvents[nextEvents.length - 1]?.sequence_no ?? null;
      } catch (eventsError) {
        if (!active) {
          return;
        }
        setStreamError((eventsError as Error).message);
      }
    };

    const handleMessage = async (event: MessageEvent) => {
      if (!active) {
        return;
      }
      try {
        const payload = JSON.parse(event.data) as {
          last_sequence?: number | null;
          run_status?: string | null;
        };
        const nextSequence = payload.last_sequence ?? null;
        if (nextSequence && nextSequence !== lastSequenceRef.current) {
          lastSequenceRef.current = nextSequence;
          await refreshEvents();
        }
        const incomingStatus = payload.run_status;
        if (incomingStatus && incomingStatus !== detailRef.current?.run.status) {
          try {
            const updatedDetail = await getRunDetail(runId);
            if (!active) {
              return;
            }
            setDetail(updatedDetail);
          } catch (detailError) {
            if (!active) {
              return;
            }
            setError((detailError as Error).message);
          }
        }
        if (incomingStatus && isTerminalRunStatus(incomingStatus)) {
          source.close();
          setStreamActive(false);
        }
      } catch {
        // Ignore malformed server payloads
      }
    };

    const handleError = () => {
      if (!active) {
        return;
      }
      setStreamActive(false);
      setStreamError("Live stream disconnected.");
    };

    source.addEventListener("open", handleOpen);
    source.addEventListener("message", handleMessage);
    source.addEventListener("error", handleError);

    return () => {
      active = false;
      source.removeEventListener("open", handleOpen);
      source.removeEventListener("message", handleMessage);
      source.removeEventListener("error", handleError);
      source.close();
      streamRef.current = null;
      setStreamActive(false);
    };
  }, [runId]);

  useEffect(() => {
    if (timelineRef.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
    }
  }, [events]);

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
            <div className="panel-header">
              <h2>Live Timeline</h2>
              <div className={`timeline-state ${streamActive ? "timeline-live" : "timeline-paused"}`}>
                {streamActive ? "Live" : "Paused"}
                {streamError ? <span className="muted mono"> — {streamError}</span> : null}
              </div>
            </div>
            <div className="run-timeline" ref={timelineRef}>
              {events.length === 0 ? (
                <p className="muted">Listening for run events…</p>
              ) : (
                events.map((event) => {
                  const timestamp = new Date(event.created_at).toLocaleTimeString();
                  const variant = getTimelineCategory(event.event_type);
                  return (
                    <article
                      key={event.id}
                      className={`run-timeline-entry run-timeline-${variant}`}
                    >
                      <header className="run-timeline-entry-meta">
                        <span className="run-timeline-event-index">#{event.sequence_no}</span>
                        <span className="run-timeline-event-type">{event.event_type}</span>
                        <span className="run-timeline-event-level">{event.level}</span>
                        <span className="run-timeline-event-time">{timestamp}</span>
                      </header>
                      <div className="run-timeline-entry-content">
                        <pre className="json-inline">{JSON.stringify(event.payload_json, null, 2)}</pre>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
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

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "errored",
  "hard_failed",
  "aborted",
  "stopped"
]);

function isTerminalRunStatus(status?: string): boolean {
  if (!status) {
    return false;
  }
  return TERMINAL_RUN_STATUSES.has(status.toLowerCase());
}

function getTimelineCategory(eventType: string): "tool" | "policy" | "artifact" | "heartbeat" | "other" {
  const normalized = eventType.toLowerCase();
  if (normalized.includes("tool")) {
    return "tool";
  }
  if (normalized.includes("policy")) {
    return "policy";
  }
  if (normalized.includes("artifact")) {
    return "artifact";
  }
  if (normalized.includes("heartbeat") || normalized.includes("pulse")) {
    return "heartbeat";
  }
  return "other";
}
