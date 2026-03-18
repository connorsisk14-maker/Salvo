import { useEffect, useMemo, useState } from "react";
import { listSkills, setSkillConfig } from "../api/control-plane";
import type { ApiSkill } from "../api/control-plane";

function formatDate(value: string | null): string {
  if (!value) {
    return "Never";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString([], { hour12: true });
}

function renderExample(example: ApiSkill["example"]): string {
  if (!example) {
    return "—";
  }
  if (typeof example === "string") {
    return example;
  }
  try {
    return JSON.stringify(example, null, 2);
  } catch {
    return String(example);
  }
}

export function SkillsPage() {
  const [overview, setOverview] = useState<Awaited<ReturnType<typeof listSkills>> | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busySkill, setBusySkill] = useState<string | null>(null);

  const loadSkills = async (workspace?: string) => {
    setLoading(true);
    setError(null);
    try {
      const payload = await listSkills(workspace);
      setOverview(payload);
      setWorkspaceId(payload.selected_workspace_id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSkills();
  }, []);

  const workspaces = overview?.workspaces ?? [];

  const skills = useMemo(() => overview?.skills ?? [], [overview]);

  const handleWorkspaceChange = (nextId: string) => {
    setWorkspaceId(nextId);
    void loadSkills(nextId);
  };

  const handleToggleSkill = async (skill: ApiSkill) => {
    const target = !skill.enabled;
    setBusySkill(skill.name);
    setError(null);
    try {
      await setSkillConfig(skill.name, workspaceId, target);
      void loadSkills(workspaceId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusySkill(null);
    }
  };

  return (
    <section className="content clip-card skills-page">
      <header className="content-header">
        <div>
          <h1>Skill Management</h1>
          <p className="muted">
            Inspect and toggle registered skills plus usage insights across workspaces.
          </p>
        </div>
        {workspaces.length > 0 ? (
          <label>
            Workspace
            <select value={workspaceId} onChange={(event) => handleWorkspaceChange(event.target.value)}>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </header>

      {error ? <p className="error-banner">{error}</p> : null}

      <div className="skills-grid">
        {skills.map((skill) => (
          <article className="skill-card" key={skill.name}>
            <header className="skill-card-header">
              <div>
                <h3>{skill.label}</h3>
                <p className="muted mono">{skill.name}</p>
              </div>
              <button
                className="button-link"
                type="button"
                onClick={() => void handleToggleSkill(skill)}
                disabled={!workspaceId || busySkill === skill.name}
              >
                {skill.enabled ? "Disable" : "Enable"}
              </button>
            </header>
            <p className="muted">{skill.description}</p>
            <div className="skill-meta">
              <div>
                <strong>Example</strong>
                <pre>{renderExample(skill.example)}</pre>
              </div>
              <div>
                <strong>Input schema</strong>
                <pre>{JSON.stringify(skill.inputSchema ?? {}, null, 2)}</pre>
              </div>
            </div>
            <div className="skill-usage-grid">
              <div>
                <span className="label">Calls</span>
                <span className="value">{skill.usage?.call_count ?? 0}</span>
              </div>
              <div>
                <span className="label">Successes</span>
                <span className="value">{skill.usage?.success_count ?? 0}</span>
              </div>
              <div>
                <span className="label">Failures</span>
                <span className="value">{skill.usage?.failure_count ?? 0}</span>
              </div>
              <div>
                <span className="label">Last used</span>
                <span className="value">{formatDate(skill.usage?.last_used_at ?? null)}</span>
              </div>
            </div>
          </article>
        ))}
        {loading && skills.length === 0 ? <p className="muted">Loading skills...</p> : null}
      </div>
    </section>
  );
}
