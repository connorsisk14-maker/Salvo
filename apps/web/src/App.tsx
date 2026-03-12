import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { ControlCenterPage } from "./pages/ControlCenterPage";
import { BoardPage } from "./pages/BoardPage";
import { ResearchReviewPage } from "./pages/ResearchReviewPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { IntegrationsPage } from "./pages/IntegrationsPage";

export function AppShell() {
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
        </nav>
        <Routes>
          <Route path="/" element={<ControlCenterPage />} />
          <Route path="/board" element={<BoardPage />} />
          <Route path="/research" element={<ResearchReviewPage />} />
          <Route path="/integrations" element={<IntegrationsPage />} />
          <Route path="/runs/:runId" element={<RunDetailPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
