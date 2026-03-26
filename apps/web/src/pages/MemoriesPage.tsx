import { useEffect, useMemo, useState } from "react";
import { listMemories, reviewMemory, type ApiMemory } from "../api/control-plane";

type StatusFilter = "all" | "unreviewed" | "accepted" | "rejected";

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString([], { hour12: true });
}

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  let cls = "status-pill ";
  if (value > 0.7) {
    cls += "ok";
  } else if (value >= 0.4) {
    cls += "warn";
  } else {
    cls += "error";
  }
  return <span className={cls}>{pct}%</span>;
}

function ReviewStatusBadge({ status }: { status: ApiMemory["review_status"] }) {
  let cls = "status-pill ";
  if (status === "accepted") {
    cls += "ok";
  } else if (status === "rejected") {
    cls += "error";
  } else {
    cls += "warn";
  }
  return <span className={cls}>{status}</span>;
}

export function MemoriesPage() {
  const [memories, setMemories] = useState<ApiMemory[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Derive the unique workspace IDs present in the loaded memories
  const workspaceIds = useMemo(() => {
    const seen = new Set<string>();
    for (const m of memories) {
      seen.add(m.workspace_id);
    }
    return Array.from(seen).sort();
  }, [memories]);

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");

  async function refresh(nextStatusFilter: StatusFilter = statusFilter) {
    try {
      const apiStatus = nextStatusFilter === "all" ? undefined : nextStatusFilter;
      const next = await listMemories(apiStatus);
      setMemories(next);
      setHasLoaded(true);
      setError(null);
    } catch (refreshError) {
      setError((refreshError as Error).message);
    }
  }

  useEffect(() => {
    void refresh(statusFilter);
  }, [statusFilter]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [statusFilter]);

  async function onReview(id: string, status: "accepted" | "rejected") {
    setBusyKey(`${id}-${status}`);
    try {
      await reviewMemory(id, status);
      await refresh();
    } catch (actionError) {
      setError((actionError as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  const normalizedQuery = query.trim().toLowerCase();

  const filteredMemories = useMemo(() => {
    return memories.filter((m) => {
      if (selectedWorkspaceId && m.workspace_id !== selectedWorkspaceId) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      return (
        m.title.toLowerCase().includes(normalizedQuery) ||
        m.memory_type.toLowerCase().includes(normalizedQuery) ||
        m.id.toLowerCase().includes(normalizedQuery) ||
        m.source_run_ids.join(" ").toLowerCase().includes(normalizedQuery)
      );
    });
  }, [memories, selectedWorkspaceId, normalizedQuery]);

  const tabCounts = useMemo(() => {
    const base = selectedWorkspaceId
      ? memories.filter((m) => m.workspace_id === selectedWorkspaceId)
      : memories;
    return {
      all: base.length,
      unreviewed: base.filter((m) => m.review_status === "unreviewed").length,
      accepted: base.filter((m) => m.review_status === "accepted").length,
      rejected: base.filter((m) => m.review_status === "rejected").length
    };
  }, [memories, selectedWorkspaceId]);

  const filterTabs: { key: StatusFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "unreviewed", label: "Unreviewed" },
    { key: "accepted", label: "Accepted" },
    { key: "rejected", label: "Rejected" }
  ];

  return (
    <div className="content clip-card">
      <header className="content-header">
        <div>
          <h1>Memory Browser</h1>
          <p className="muted">
            Browse, search, and review memory entries stored across workspaces.
          </p>
        </div>
        {workspaceIds.length > 0 ? (
          <label>
            Workspace
            <select
              value={selectedWorkspaceId}
              onChange={(event) => setSelectedWorkspaceId(event.target.value)}
            >
              <option value="">All workspaces</option>
              {workspaceIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </header>

      {error ? <p className="error-banner">{error}</p> : null}

      <section className="panel">
        <div className="board-filter-row">
          <div className="board-filter-pills" role="tablist" aria-label="Status filter">
            {filterTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={statusFilter === tab.key}
                className={`status-pill${statusFilter === tab.key ? " board-pill-active" : ""}`}
                onClick={() => setStatusFilter(tab.key)}
              >
                {tab.label}
                {hasLoaded ? (
                  <span style={{ marginLeft: "0.35rem", opacity: 0.7 }}>
                    ({tabCounts[tab.key]})
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <label>
            Search memories
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by title, type, run ID..."
            />
          </label>
        </div>
        {hasLoaded ? (
          <p className="muted">
            Showing {filteredMemories.length} of {tabCounts[statusFilter === "all" ? "all" : statusFilter]} memories.
          </p>
        ) : null}
      </section>

      <section className="panel">
        {!hasLoaded ? (
          <div>
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="skeleton skeleton-card" />
            ))}
          </div>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Type</th>
                <th>Confidence</th>
                <th>Status</th>
                <th>Sources</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredMemories.map((memory) => (
                <tr key={memory.id}>
                  <td>
                    <strong>{memory.title}</strong>
                    <div className="mono muted">{memory.id}</div>
                    {selectedWorkspaceId === "" ? (
                      <div className="muted" style={{ fontSize: "0.75rem" }}>
                        {memory.workspace_id}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <span className="status-pill board-chip-neutral">{memory.memory_type}</span>
                  </td>
                  <td>
                    <ConfidenceBadge value={memory.confidence} />
                  </td>
                  <td>
                    <ReviewStatusBadge status={memory.review_status} />
                  </td>
                  <td>{memory.source_run_ids.length}</td>
                  <td className="muted">{formatDate(memory.created_at)}</td>
                  <td>
                    {memory.review_status === "unreviewed" ? (
                      <>
                        <button
                          type="button"
                          className="button-link"
                          disabled={busyKey === `${memory.id}-accepted`}
                          onClick={() => {
                            void onReview(memory.id, "accepted");
                          }}
                        >
                          {busyKey === `${memory.id}-accepted` ? "Accepting..." : "Accept"}
                        </button>
                        <button
                          type="button"
                          className="button-link"
                          disabled={busyKey === `${memory.id}-rejected`}
                          onClick={() => {
                            void onReview(memory.id, "rejected");
                          }}
                        >
                          {busyKey === `${memory.id}-rejected` ? "Rejecting..." : "Reject"}
                        </button>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {filteredMemories.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <div className="empty-state">No memories yet.</div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
