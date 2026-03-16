import { FormEvent, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { clearStoredApiToken, getStoredApiToken, setStoredApiToken, subscribeToApiToken } from "./api/auth";
import { ControlCenterPage } from "./pages/ControlCenterPage";
import { BoardPage } from "./pages/BoardPage";
import { ResearchReviewPage } from "./pages/ResearchReviewPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { IntegrationsPage } from "./pages/IntegrationsPage";

export function AppShell() {
  const [apiToken, setApiToken] = useState(() => getStoredApiToken());
  const [draftToken, setDraftToken] = useState(() => getStoredApiToken());
  const [tokenPromptOpen, setTokenPromptOpen] = useState(() => getStoredApiToken().length === 0);

  useEffect(() => {
    return subscribeToApiToken(() => {
      const nextToken = getStoredApiToken();
      setApiToken(nextToken);
      setDraftToken(nextToken);
      if (nextToken.length === 0) {
        setTokenPromptOpen(true);
      }
    });
  }, []);

  function onSubmitToken(event: FormEvent) {
    event.preventDefault();
    const savedToken = setStoredApiToken(draftToken);
    setApiToken(savedToken);
    setDraftToken(savedToken);
    setTokenPromptOpen(false);
  }

  const tokenConfigured = apiToken.length > 0;

  return (
    <div className="app-frame">
      <main className="main-panel">
        <nav className="top-nav">
          <NavLink
            to="/"
            end
            className={({ isActive }) => `top-nav-link ${isActive ? "top-nav-link-active" : ""}`}
          >
            Control Center
          </NavLink>
          <NavLink
            to="/board"
            className={({ isActive }) => `top-nav-link ${isActive ? "top-nav-link-active" : ""}`}
          >
            Tasks & Runs Board
          </NavLink>
          <NavLink
            to="/research"
            className={({ isActive }) => `top-nav-link ${isActive ? "top-nav-link-active" : ""}`}
          >
            Research Review
          </NavLink>
          <NavLink
            to="/integrations"
            className={({ isActive }) => `top-nav-link ${isActive ? "top-nav-link-active" : ""}`}
          >
            Integrations
          </NavLink>
          <button
            type="button"
            className="top-nav-token"
            onClick={() => {
              setDraftToken(apiToken);
              setTokenPromptOpen(true);
            }}
          >
            API Token
          </button>
        </nav>

        {tokenConfigured ? (
          <Routes>
            <Route path="/" element={<ControlCenterPage />} />
            <Route path="/board" element={<BoardPage />} />
            <Route path="/research" element={<ResearchReviewPage />} />
            <Route path="/integrations" element={<IntegrationsPage />} />
            <Route path="/runs/:runId" element={<RunDetailPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        ) : (
          <section className="content clip-card auth-locked-state">
            <header className="content-header">
              <h1>Dashboard Locked</h1>
              <p className="muted">
                Enter the bearer token from <span className="mono">SALVO_API_TOKEN</span> to use the control plane.
              </p>
            </header>
          </section>
        )}
      </main>

      {tokenPromptOpen ? (
        <div className="auth-modal-backdrop" role="presentation">
          <div className="auth-modal clip-card">
            <form className="content auth-modal-content" onSubmit={onSubmitToken}>
              <header className="content-header">
                <h1>API Token</h1>
                <p className="muted">
                  Enter the bearer token configured on the API server. It is stored in local storage for this browser.
                </p>
              </header>

              <label>
                Bearer token
                <input
                  value={draftToken}
                  onChange={(event) => setDraftToken(event.target.value)}
                  type="password"
                  autoFocus
                  required
                />
              </label>

              <div className="auth-modal-actions">
                <button className="button-link" type="submit">
                  Save token
                </button>
                {tokenConfigured ? (
                  <>
                    <button
                      className="button-link"
                      type="button"
                      onClick={() => {
                        setDraftToken(apiToken);
                        setTokenPromptOpen(false);
                      }}
                    >
                      Close
                    </button>
                    <button
                      className="button-link"
                      type="button"
                      onClick={() => {
                        clearStoredApiToken();
                        setDraftToken("");
                        setApiToken("");
                        setTokenPromptOpen(true);
                      }}
                    >
                      Clear saved token
                    </button>
                  </>
                ) : null}
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
