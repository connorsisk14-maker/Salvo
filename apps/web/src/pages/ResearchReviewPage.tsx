import { useEffect, useMemo, useState } from "react";
import {
  listMemories,
  listResearchExperiments,
  listResearch,
  reviewMemory,
  reviewResearchExperiment,
  reviewResearch,
  type ApiMemory,
  type ApiResearchExperiment,
  type ApiResearchDoc
} from "../api/control-plane";

type ReviewFilter = "unreviewed" | "accepted" | "rejected";

export function ResearchReviewPage() {
  const [filter, setFilter] = useState<ReviewFilter>("unreviewed");
  const [docs, setDocs] = useState<ApiResearchDoc[]>([]);
  const [experiments, setExperiments] = useState<ApiResearchExperiment[]>([]);
  const [memories, setMemories] = useState<ApiMemory[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh(nextFilter = filter) {
    try {
      const [nextDocs, nextExperiments, nextMemories] = await Promise.all([
        listResearch(nextFilter),
        listResearchExperiments(nextFilter),
        listMemories(nextFilter)
      ]);
      setDocs(nextDocs);
      setExperiments(nextExperiments);
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
    const intervalId = window.setInterval(() => {
      void refresh();
    }, 1500);

    return () => {
      window.clearInterval(intervalId);
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

  async function onReviewExperiment(id: string, status: ReviewFilter) {
    setBusyKey(`experiment-${id}-${status}`);
    try {
      await reviewResearchExperiment(id, status);
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
      experiments: experiments.length,
      memories: memories.length
    }),
    [docs.length, experiments.length, memories.length]
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
          Showing {reviewCounts.docs} research docs, {reviewCounts.experiments} experiments, and{" "}
          {reviewCounts.memories} memory entries.
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
        <h2>Research Experiments</h2>
        <table className="grid-table">
          <thead>
            <tr>
              <th>Family</th>
              <th>Sample Size</th>
              <th>Confidence</th>
              <th>Status</th>
              <th>Published</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {experiments.map((experiment) => (
              <tr key={experiment.id}>
                <td>
                  <strong>{experiment.contract_category}</strong>
                  <div className="muted">
                    {experiment.contract_subcategory ?? "-"}
                  </div>
                  <div className="mono muted">{experiment.contract_family_key}</div>
                </td>
                <td>{experiment.sample_size}</td>
                <td>{experiment.confidence}</td>
                <td>{experiment.review_status}</td>
                <td>{experiment.published_at ? "yes" : "no"}</td>
                <td>
                  <button
                    type="button"
                    className="button-link"
                    disabled={busyKey === `experiment-${experiment.id}-accepted`}
                    onClick={() => {
                      void onReviewExperiment(experiment.id, "accepted");
                    }}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="button-link"
                    disabled={busyKey === `experiment-${experiment.id}-rejected`}
                    onClick={() => {
                      void onReviewExperiment(experiment.id, "rejected");
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
