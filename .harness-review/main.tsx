import { createRoot } from "react-dom/client";
import { useState } from "react";
import "../src/index.css";
import { initI18n } from "../src/i18n";
import { dismissTop } from "../src/utils/backDismiss";
import { LiveRunTracker } from "../src/modals/LiveRunTracker";

const q = new URLSearchParams(location.search);
const sessions: any = {
  tempo: { id: "t1", date: "2026-10-02", type: "TEMPO", desc: "Tempo 6 km", km: 6, pace: 295 },
  intervals: { id: "i1", date: "2026-10-02", type: "INTERVALS", desc: "6 x 800m", km: 8, pace: 270, sd: { kind: "intervals", reps: 6, repM: 800, recover: "90s" } },
  easy: { id: "e1", date: "2026-10-02", type: "EASY", desc: "Easy 8 km", km: 8, pace: 340 },
};
function H() {
  const [settings, setSettings] = useState<any>(() => {
    const s: any = { maxHR: 190, restHR: 55 };
    if (q.get("seen")) s.guidanceTourSeen = true;
    try { const p = localStorage.getItem("hs"); if (p) Object.assign(s, JSON.parse(p)); } catch {}
    return s;
  });
  const patch = (p: any) => { (window as any).__patches = [...((window as any).__patches||[]), p]; setSettings((s: any) => { const n = { ...s, ...p }; try { localStorage.setItem("hs", JSON.stringify(n)); } catch {} ; (window as any).__settings = n; return n; }); };
  const [log, setLog] = useState<any[]>([]);
  return <LiveRunTracker session={sessions[q.get("s") || "tempo"] ?? null} settings={settings} onSettingsPatch={patch}
    hrMethod="off" onFinish={(p) => { (window as any).__finish = p; setLog(l => [...l, p]); }} onClose={() => { (window as any).__closed = ((window as any).__closed||0)+1; }} showToast={(m) => { (window as any).__toast = m; }} />;
}
initI18n("en").then(() => createRoot(document.getElementById("root")!).render(<H />));

window.addEventListener("keydown", e => { if (e.key === "Escape") { (window as any).__esc = dismissTop(); } });
