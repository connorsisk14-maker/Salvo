import { Navigate, Route, Routes } from "react-router-dom";
import { ControlCenterPage } from "./pages/ControlCenterPage";
import { RunDetailPage } from "./pages/RunDetailPage";

export function AppShell() {
  return (
    <div className="app-frame">
      <main className="main-panel">
        <Routes>
          <Route path="/" element={<ControlCenterPage />} />
          <Route path="/runs/:runId" element={<RunDetailPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
