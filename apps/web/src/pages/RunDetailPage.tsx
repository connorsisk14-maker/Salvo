import { useEffect, useMemo, useRef, useState } from "react";
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

const TIMELINE_CATEGORY_ORDER: Array<"tool" | "policy" | "artifact" | "heartbeat" | "other"> = [
  "tool",
  "policy",
  "artifact",
  "heartbeat",
  "other"
];

const TIMELINE_CATEGORY_LABELS: Record<string, string> = {
  tool: "Tool calls & results",
  policy: "Policy guards",
  artifact: "Artifact tracking",
  heartbeat: "Daemon heartbeats",
  other: "Miscellaneous events"
};


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
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const lastSequenceRef = useRef<number | null>(null);
  const detailRef = useRef<ApiRunDetail | null>(null);

  const timelineGroups = useMemo(() => {
    const categoryMap = new Map<
      "tool" | "policy" | "artifact" | "heartbeat" | "other",
      ApiRunEvent[]
    >();
    for (const event of events) {
      const category = getTimelineCategory(event.event_type);
      const bucket = categoryMap.get(category) ?? [];
      bucket.push(event);
      categoryMap.set(category, bucket);
    }
    return Array.from(categoryMap.entries())
      .map(([category, items]) => ({
        category,
        events: items.slice().sort((a, b) => a.sequence_no - b.sequence_no)
      }))
      .sort((a, b) => TIMELINE_CATEGORY_ORDER.indexOf(a.category) - TIMELINE_CATEGORY_ORDER.indexOf(b.category));
  }, [events]);

  const toolEvents = useMemo(() => {
    return events
      .filter((event) => getTimelineCategory(event.event_type) === "tool")
      .slice()
      .sort((a, b) => b.sequence_no - a.sequence_no)
      .slice(0, 4);
  }, [events]);

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
      setStreamActive(false);
      return;
    }

    let active = true;
    let intervalId: number | null = null;
    setStreamActive(true);
    setStreamError(null);

    const refreshLiveState = async () => {
      try {
        const [nextEvents, nextDetail] = await Promise.all([
          getRunEvents(runId),
          getRunDetail(runId)
        ]);
        if (!active) {
          return;
        }
        setEvents(nextEvents);
        setDetail(nextDetail);
        lastSequenceRef.current = nextEvents[nextEvents.length - 1]?.sequence_no ?? null;
        setStreamActive(true);
        setStreamError(null);
        if (isTerminalRunStatus(nextDetail.run.status)) {
          setStreamActive(false);
          if (intervalId !== null) {
            window.clearInterval(intervalId);
            intervalId = null;
          }
        }
      } catch (pollError) {
        if (!active) {
          return;
        }
        setStreamActive(false);
        setStreamError((pollError as Error).message);
      }
    };

    void refreshLiveState();
    intervalId = window.setInterval(() => {
      void refreshLiveState();
    }, 2_000);

    return () => {
      active = false;
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
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

  const evaluationState = detail?.evaluation
    ? detail.evaluation.passed
      ? "pass"
      : detail.evaluation.hard_fail_reason
      ? "fail"
      : "warn"
    : "pending";
  const contractJson = detail?.contract.contract_json as Record<string, unknown> | undefined;
  const contractCategory = contractJson
    ?
        readContractField(contractJson, "contract_category") ??
        readContractField(contractJson, "category") ??
        readContractField(contractJson, "family") ??
        "-"
    : "-";
  const contractSubcategory = contractJson
    ?
        readContractField(contractJson, "contract_subcategory") ??
        readContractField(contractJson, "subcategory") ??
        "-"
    : "-";
  const contractFamilyKey = contractJson
    ?
        readContractField(contractJson, "contract_family_key") ??
        readContractField(contractJson, "family_key") ??
        "-"
    : "-";

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
          <section className="panel run-overview-panel">
            <div className="panel-header">
              <h2>Run Overview</h2>
              <p className="muted">Operational metadata for this execution.</p>
            </div>
            <div className="run-overview-grid">
              <div>
                <p className="muted">Run status</p>
                <span className={`run-status-chip run-status-${detail.run.status?.toLowerCase() ?? "unknown"}`}>
                  {detail.run.status}
                </span>
              </div>
              <div>
                <p className="muted">Task status</p>
                <strong>{detail.task.status}</strong>
              </div>
              <div>
                <p className="muted">Attempt</p>
                <strong>{detail.run.attempt_no}</strong>
              </div>
              <div>
                <p className="muted">Started</p>
                <strong>{new Date(detail.run.created_at).toLocaleString()}</strong>
              </div>
              <div>
                <p className="muted">Risk</p>
                <strong>{detail.contract.risk}</strong>
              </div>
            </div>
          </section>

          <section className="panel contract-panel">
            <div className="panel-header">
              <h2>Contract</h2>
              <span className="muted mono">{detail.contract.id}</span>
            </div>
            <div className="contract-meta-grid">
              <div>
                <p className="muted">Category</p>
                <strong>{contractCategory}</strong>
              </div>
              <div>
                <p className="muted">Subcategory</p>
                <strong>{contractSubcategory}</strong>
              </div>
              <div>
                <p className="muted">Family key</p>
                <strong>{contractFamilyKey}</strong>
              </div>
            </div>
            <pre className="json-block contract-json">
              {JSON.stringify(detail.contract.contract_json, null, 2)}
            </pre>
          </section>

          <section className="panel evaluation-panel">
            <div className="panel-header">
              <h2>Evaluation Breakdown</h2>
            </div>
            {detail.evaluation ? (
              <div className="evaluation-summary">
                <div className={`evaluation-pill evaluation-pill-${evaluationState}`}>
                  {evaluationState === "pass"
                    ? "Passed"
                    : evaluationState === "fail"
                    ? "Failed"
                    : "Pending"}
                </div>
                <div className="evaluation-metrics">
                  <div>
                    <p className="muted">Outcome</p>
                    <strong>{detail.evaluation.outcome}</strong>
                  </div>
                  <div>
                    <p className="muted">Score</p>
                    <strong>{detail.evaluation.score}</strong>
                  </div>
                  <div>
                    <p className="muted">Hard fail</p>
                    <span>{detail.evaluation.hard_fail_reason ?? "none"}</span>
                  </div>
                </div>
                <div className="evaluation-findings">
                  <p className="muted">Findings</p>
                  <ul>
                    {detail.evaluation.findings_json.map((finding) => (
                      <li key={finding}>{finding}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <p className="muted">Evaluation pending.</p>
            )}
          </section>

          <section className="panel timeline-panel">
            <div className="panel-header">
              <h2>Operational Timeline</h2>
              <div className={`timeline-state ${streamActive ? "timeline-live" : "timeline-paused"}`}>
                {streamActive ? "Live" : "Paused"}
                {streamError ? <span className="muted mono"> — {streamError}</span> : null}
              </div>
            </div>
            <div className="timeline-grid" ref={timelineRef}>
              {events.length === 0 ? (
                <p className="muted">Listening for run events…</p>
              ) : (
                timelineGroups.map((group) => (
                  <div className="timeline-group" key={group.category}>
                    <header className="timeline-group-header">
                      <span>{TIMELINE_CATEGORY_LABELS[group.category]}</span>
                      <span className="muted">{group.events.length} events</span>
                    </header>
                    <div className="timeline-group-entries">
                      {group.events.map((event) => (
                        <article
                          key={event.id}
                          className={`run-timeline-entry run-timeline-${group.category}`}
                        >
                          <header className="run-timeline-entry-meta">
                            <span className="run-timeline-event-index">#{event.sequence_no}</span>
                            <span className="run-timeline-event-type">{event.event_type}</span>
                            <span className="run-timeline-event-level">{event.level}</span>
                            <span className="run-timeline-event-time">
                              {new Date(event.created_at).toLocaleTimeString()}
                            </span>
                          </header>
                          <div className="run-timeline-entry-content">
                            <pre className="json-inline">
                              {JSON.stringify(event.payload_json, null, 2)}
                            </pre>
                          </div>
                        </article>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="panel tool-panel">
            <div className="panel-header">
              <h2>Tool call visibility</h2>
              <p className="muted">Recent tool invocations and outcome payloads.</p>
            </div>
            {toolEvents.length === 0 ? (
              <p className="muted">No tool events yet.</p>
            ) : (
              <div className="tool-call-grid">
                {toolEvents.map((event) => {
                  const payload = event.payload_json as Record<string, unknown>;
                  const candidate =
                    (payload.tool as string) ??
                    (payload.tool_name as string) ??
                    (payload.name as string) ??
                    event.event_type;
                  const toolSignature = typeof candidate === "string" ? candidate : event.event_type;
                  const snippet = JSON.stringify(payload, null, 2);
                  const truncated = snippet.length > 320 ? `${snippet.slice(0, 320)}…` : snippet;
                  return (
                    <article className="tool-call-card" key={event.id}>
                      <header>
                        <strong>{toolSignature}</strong>
                        <span className="muted">#{event.sequence_no}</span>
                      </header>
                      <div className="tool-call-meta">
                        <span className="run-timeline-event-time">
                          {new Date(event.created_at).toLocaleTimeString()}
                        </span>
                        <span>{event.level}</span>
                      </div>
                      <pre className="json-inline">{truncated}</pre>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section id="proof" className="panel proof-panel">
            <div className="panel-header">
              <div>
                <h2>Proof of Work</h2>
                <p className="muted">Artifact records and final payload evidence.</p>
              </div>
              <span className="muted">{detail.artifacts.length} artifacts</span>
            </div>
            {detail.artifacts.length === 0 ? (
              <p className="muted">No artifacts recorded.</p>
            ) : (
              <div className="artifact-grid">
                {detail.artifacts.map((artifact) => {
                  const preview = artifactPreviews[artifact.id];
                  return (
                    <article className="artifact-card" key={artifact.id}>
                      <header className="artifact-card-header">
                        <div>
                          <p className="muted">{artifact.artifact_type}</p>
                          <strong className="mono">{artifact.path}</strong>
                        </div>
                        <div className="artifact-card-actions">
                          <button
                            type="button"
                            className="button-link"
                            onClick={() => {
                              void onOpenArtifact(artifact.id);
                            }}
                          >
                            Open file
                          </button>
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
                        </div>
                      </header>
                      <p className="muted">{new Date(artifact.created_at).toLocaleString()}</p>
                      {preview ? (
                        <div className="artifact-preview">
                          {preview.kind === "text" ? (
                            <pre className="json-inline">{preview.content}</pre>
                          ) : null}
                          {preview.kind === "image" ? (
                            <img
                              src={artifactContentUrls[artifact.id]}
                              alt={`Artifact ${artifact.id}`}
                              className="artifact-preview-image"
                            />
                          ) : null}
                          {preview.kind === "binary" ? (
                            <p className="muted">Binary artifact. Use Open file to inspect.</p>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
            <div className="final-payload-card">
              <h3>Final Payload</h3>
              {detail.final_payload ? (
                <pre className="json-block">{JSON.stringify(detail.final_payload, null, 2)}</pre>
              ) : (
                <p className="muted">Final payload not available.</p>
              )}
            </div>
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

function readContractField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}
