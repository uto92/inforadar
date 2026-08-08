import { Suspense, lazy, useEffect } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { syncEngine } from "./lib/sync/engine";
import AdminPage from "./pages/AdminPage";
import EventsPage from "./pages/EventsPage";
import NoticePage from "./pages/NoticePage";

// html5-qrcode が大きいため、スキャン画面のみコード分割して遅延ロード
const ScanPage = lazy(() => import("./pages/ScanPage"));

export default function App() {
  useEffect(() => {
    syncEngine.start();
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<EventsPage />} />
        <Route
          path="/scan/:eventId"
          element={
            <Suspense
              fallback={
                <main className="page">
                  <p className="muted">読み込み中…</p>
                </main>
              }
            >
              <ScanPage />
            </Suspense>
          }
        />
        <Route path="/admin/:eventId" element={<AdminPage />} />
        <Route path="/notice/:eventId" element={<NoticePage />} />
      </Routes>
    </BrowserRouter>
  );
}
