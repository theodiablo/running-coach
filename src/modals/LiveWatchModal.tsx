// Watch a run that is happening right now, from another of the runner's own
// signed-in sessions. Read-only: everything here comes from the `live_runs` row
// that the recording phone upserts (see src/live/publisher.ts).
//
// The recorder publishes only when a GPS fix lands, so silence is ambiguous by
// construction: a runner waiting at a crossing, a phone in a tunnel, and an app
// that died all look identical from here. The copy therefore never asserts
// something is wrong, it only reports how long it has been quiet.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pause, Radio, X } from "lucide-react";
import { fmt } from "../utils/format";
import { RouteMap } from "../components/RouteMap";
import { useDismissable } from "../hooks/useDismissable";
import type { LiveRunRow } from "../live/publisher";

type LiveWatchModalProps = {
  row: LiveRunRow | null;
  onClose: () => void;
};

// How long without an update before we say so. Generously above the publisher's
// 30s cadence: a couple of missed uploads is a red light, not an incident.
const QUIET_MS = 180000;
const TICK_MS = 10000; // relabel "x ago" locally — no network, no DB read

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-800 rounded-xl px-3 py-2.5 text-center">
      <p className="text-2xl font-bold text-white leading-tight tabular-nums">{value}</p>
      <p className="text-[11px] text-slate-400 uppercase tracking-wide">{label}</p>
    </div>
  );
}

export function LiveWatchModal({ row, onClose }: LiveWatchModalProps) {
  const { t } = useTranslation();
  useDismissable(true, onClose);

  // "Now", held in state and advanced on a slow tick, so the freshness line
  // stays honest while the modal sits open between pushes. Local only: no
  // network, no read — reading the clock during render would make this component
  // impure and the label would drift with unrelated re-renders.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const points = row?.points || [];
  const stats = row?.stats || {};
  const updatedAt = row ? Date.parse(row.updated_at) : NaN;
  const quietMs = Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : 0;
  const ended = !row || row.status === "ended";
  const quiet = !ended && quietMs >= QUIET_MS;
  const hasTrack = points.some(Boolean);

  const freshness = () => {
    if (!Number.isFinite(updatedAt)) return "";
    const secs = Math.round(quietMs / 1000);
    if (secs < 15) return t("liveShare.watch.updatedNow");
    if (secs < 60) return t("liveShare.watch.updatedSecs", { secs });
    return t("liveShare.watch.updatedMins", { mins: Math.round(secs / 60) });
  };

  return (
    <div className="fixed inset-0 bg-slate-900 z-50 flex flex-col animate-slide-up">
      <header className="flex items-center justify-between px-4 border-b border-slate-800"
        style={{ height: "calc(44px + var(--safe-top))", paddingTop: "var(--safe-top)" }}>
        <div className="flex items-center gap-1.5">
          {ended ? (
            <Radio size={15} className="text-slate-500" />
          ) : row?.status === "paused" ? (
            <Pause size={15} className="text-amber-400" />
          ) : (
            <span className="relative flex h-2.5 w-2.5" aria-hidden>
              <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75 animate-ping" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
            </span>
          )}
          <span className="text-sm font-semibold">{t("liveShare.watch.title")}</span>
        </div>
        <button onClick={onClose} aria-label={t("common.close")}
          className="text-slate-400 hover:text-white p-1.5"><X size={18} /></button>
      </header>

      <div className="flex-1 min-h-0 relative">
        <RouteMap points={points} follow={!ended} interactive className="h-full w-full" style={{}} />
        {!hasTrack && (
          <div className="absolute inset-x-0 bottom-3 flex justify-center pointer-events-none">
            <span className="rounded-full bg-slate-900/85 border border-slate-700 px-3 py-1.5 text-xs text-slate-300">
              {t("liveShare.watch.waiting")}
            </span>
          </div>
        )}
      </div>

      <div className="p-4 space-y-3 border-t border-slate-800" style={{ paddingBottom: "calc(1rem + var(--safe-bottom))" }}>
        <div className="grid grid-cols-3 gap-2">
          <Stat label={t("liveShare.watch.stats.distance")} value={(stats.km ?? 0).toFixed(2)} />
          <Stat label={t("liveShare.watch.stats.time")}
            value={fmt.dur(stats.durationSec ?? 0) === "--" ? "0:00" : fmt.dur(stats.durationSec ?? 0)} />
          <Stat label={t("liveShare.watch.stats.pace")} value={fmt.pace(Math.round(stats.avgPace ?? 0))} />
        </div>

        {ended ? (
          <p className="text-sm text-center text-slate-400">{t("liveShare.watch.ended")}</p>
        ) : quiet ? (
          <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs leading-snug text-amber-100 text-center">
            {t("liveShare.watch.signalLost")}
          </p>
        ) : (
          <p className="text-[11px] text-center text-slate-500">
            {row?.status === "paused" ? t("liveShare.watch.paused") + " · " : ""}{freshness()}
          </p>
        )}
      </div>
    </div>
  );
}
