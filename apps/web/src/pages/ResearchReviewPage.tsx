import { useEffect, useMemo, useState } from "react";
import {
  listMemories,
  listResearch,
  reviewMemory,
  reviewResearch,
  streamUrl,
  type ApiMemory,
  type ApiResearchDoc
} from "../api/control-plane";

type ReviewFilter = "unreviewed" | "accepted" | "rejected";

export function ResearchReviewPage() {
  const [filter, setFilter] = useState<ReviewFilter>("unreviewed");
  const [docs, setDocs] = useState<ApiResearchDoc[]>([]);
  const [memories, setMemories] = useState<ApiMemory[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh(nextFilter = filter) {
    try {
      const [nextDocs, nextMemories] = await Promise.all([
        listResearch(nextFilter),
        listMemories(nextFilter)
      ]);
      setDocs(nextDocs);
      setMemories(nextMemories);
      setError(null);
    } catch (refreshError) {
      setError((refreshError as Error).message);
    }
  }

  useEffect(() => {
    void refresh(filter);
  }, [filter]);

  useEffect(() => {
    const eventSource = new EventSource(streamUrl("/stream/overview"));
    eventSource.onmessage = () => {
      void refresh();
    };
    eventSource.onerror = () => {
      // rely on EventSource internal retry behavior
    };

    return () => {
      eventSource.close();
    };
  }, [filter]);

  async function onReviewResearch(id: string, status: ReviewFilter) {
    setBusyKey(`doc-${id}-${status}`);
    try {
      await reviewResearch(id, status);
      await refresh();
    } catch (actionError) {
      setError((actionError as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  async function onReviewMemory(id: string, status: ReviewFilter) {
    setBusyKey(`memory-${id}-${status}`);
    try {
      await reviewMemory(id, status);
      await refresh();
    } catch (actionError) {
      setError((actionError as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  const reviewCounts = useMemo(
    () => ({
      docs: docs.length,
      memories: memories.length
    }),
    [docs.length, memories.length]
  );

  return (
    <div className="content clip-card">
      <header className="content-header">
        <h1>Research Review</h1>
        <p className="muted">
          Review synthesized research and memory entries before using them to influence future runs.
        </p>
      </header>

      {error ? <p className="error-banner">{error}</p> : null}

      <section className="panel">
        <div className="board-filter-row">
          <label>
            Review filter
            <select value={filter} onChange={(event) => setFilter(event.target.value as ReviewFilter)}>
              <option value="unreviewed">unreviewed</option>
              <option value="accepted">accepted</option>
              <option value="rejected">rejected</option>
            </select>
          </label>
        </div>

        <p className="muted">
          Showing {reviewCounts.docs} research docs and {reviewCounts.memories} memory entries.
        </p>
      </section>

      <section className="panel">
        <h2>Research Documents</h2>
        <table className="grid-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Topic</th>
              <th>Confidence</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((doc) => (
              <tr key={doc.id}>
                <td>
                  <strong>{doc.title}</strong>
                  <div className="mono muted">{doc.id}</div>
                </td>
                <td>{doc.topic}</td>
                <td>{doc.confidence}</td>
                <td>{doc.review_status}</td>
                <td>
                  <button
                    type="button"
                    className="button-link"
                    disabled={busyKey === `doc-${doc.id}-accepted`}
                    onClick={() => {
                      void onReviewResearch(doc.id, "accepted");
                    }}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="button-link"
                    disabled={busyKey === `doc-${doc.id}-rejected`}
                    onClick={() => {
                      void onReviewResearch(doc.id, "rejected");
                    }}
                  >
                    Reject
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Memory Entries</h2>
        <table className="grid-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Type</th>
              <th>Confidence</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {memories.map((memory) => (
              <tr key={memory.id}>
                <td>
                  <strong>{memory.title}</strong>
                  <div className="mono muted">{memory.id}</div>
                </td>
                <td>{memory.memory_type}</td>
                <td>{memory.confidence}</td>
                <td>{memory.review_status}</td>
                <td>
                  <button
                    type="button"
                    className="button-link"
                    disabled={busyKey === `memory-${memory.id}-accepted`}
                    onClick={() => {
                      void onReviewMemory(memory.id, "accepted");
                    }}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="button-link"
                    disabled={busyKey === `memory-${memory.id}-rejected`}
                    onClick={() => {
                      void onReviewMemory(memory.id, "rejected");
                    }}
                  >
                    Reject
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
