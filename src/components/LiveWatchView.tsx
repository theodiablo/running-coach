// The run-in-progress display, shared by the two things that show one: the
// in-app watch modal (the runner's own other session) and the public
// /watch/:token page (anyone holding the link).
//
// It lives here so the two can't drift, and the reason that matters is the
// STALENESS MODEL rather than the layout. The recorder publishes only when a
// GPS fix lands, so silence is ambiguous by construction: a runner waiting at a
// crossing, a phone in a tunnel, and an app the OS killed are indistinguishable
// from out here. Nothing below ever asserts something is wrong — it reports how
// long it has been quiet and lets the reader draw their own conclusion. A
// second copy of this display would eventually start guessing.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pause, Radio } from "lucide-react";
import { fmt } from "../utils/format";
import { RouteMap } from "./RouteMap";
import type { PublicLiveRun } from "../live/shareLink";
import { liveWatchDotState } from "../live/watchStatus";

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

// The live/paused/ended dot, so both headers read identically at a glance.
export function LiveWatchDot({ ended, paused }: { ended: boolean; paused: boolean }) {
  if (ended) return <Radio size={15} className="text-slate-500" />;
  if (paused) return <Pause size={15} className="text-amber-400" />;
  return (
    <span className="relative flex h-2.5 w-2.5" aria-hidden>
      <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75 animate-ping" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
    </span>
  );
}

// Map + stats + the one status line. The caller owns the chrome around it
// (the modal's close button, the public page's masthead), because that is the
// only part the two surfaces legitimately disagree about.
export function LiveWatchView(
  { run, bottomInset = true }:
  // `bottomInset` false when the caller renders its own chrome below this (the
  // public page's footer), so the iOS home-indicator gap is padded once.
  { run: PublicLiveRun | null; bottomInset?: boolean },
) {
  const { t } = useTranslation();

  // "Now", held in state and advanced on a slow tick, so the freshness line
  // stays honest while the view sits open between pushes. Local only: no
  // network, no read — reading the clock during render would make this
  // component impure and the label would drift with unrelated re-renders.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const points = run?.points || [];
  const stats = run?.stats || {};
  const updatedAt = run ? Date.parse(run.updated_at) : NaN;
  const quietMs = Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : 0;
  const { ended, paused } = liveWatchDotState(run);
  // A paused run publishes nothing BY DESIGN — it drops fixes, and the pause was
  // itself pushed through as a status change. So silence after one is expected,
  // not a lost signal: the row already says exactly what is going on, and the
  // freshness line below still reports how old that answer is.
  const quiet = !ended && !paused && quietMs >= QUIET_MS;
  const hasTrack = points.some(Boolean);

  const freshness = () => {
    if (!Number.isFinite(updatedAt)) return "";
    const secs = Math.round(quietMs / 1000);
    if (secs < 15) return t("liveShare.watch.updatedNow");
    if (secs < 60) return t("liveShare.watch.updatedSecs", { secs });
    return t("liveShare.watch.updatedMins", { mins: Math.round(secs / 60) });
  };

  return (
    <>
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

      <div className="p-4 space-y-3 border-t border-slate-800"
        style={bottomInset ? { paddingBottom: "calc(1rem + var(--safe-bottom))" } : undefined}>
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
            {paused ? t("liveShare.watch.paused") + " · " : ""}{freshness()}
          </p>
        )}
      </div>
    </>
  );
}
