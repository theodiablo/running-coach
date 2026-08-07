// The run-in-progress display, shared by the in-app watch modal and the public
// /watch/:token page. Shared so the two can't drift on the STALENESS MODEL, not
// for the layout: the recorder publishes only when a GPS fix lands, so a runner
// waiting at a crossing, a phone in a tunnel and an app the OS killed are
// indistinguishable from out here. Nothing below asserts something is wrong —
// it reports how long it has been quiet. A second copy would start guessing.
//
// Layout is container-queried, not viewport-queried: the same component renders
// full-screen and inside a modal. Detail: docs/live-sharing.md.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pause, Radio } from "lucide-react";
import { fmt } from "../utils/format";
import { RouteMap } from "./RouteMap";
import { RunChart, Readout } from "./RunChart";
import { buildRunSeries } from "../utils/runSeries";
import { flattenTrack, elevGainM } from "../utils/geo";
import type { PublicLiveRun } from "../live/shareLink";

// How long without an update before we say so. Generously above the publisher's
// 30s cadence: a couple of missed uploads is a red light, not an incident.
const QUIET_MS = 180000;
const TICK_MS = 10000; // relabel "x ago" locally — no network, no DB read

export type LiveWatchStatus = {
  ended: boolean;
  paused: boolean;
  quiet: boolean;
  hasTrack: boolean;
};

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

// Map + stats + chart + the one status line. The caller owns the chrome around
// it (the modal's close button, the public page's masthead), because that is
// the only part the two surfaces legitimately disagree about.
export function LiveWatchView(
  { run, onStatus, bottomInset = true }:
  // `bottomInset` false when the caller renders its own chrome below this (the
  // public page's footer), so the iOS home-indicator gap is padded once.
  { run: PublicLiveRun | null; onStatus?: (s: LiveWatchStatus) => void; bottomInset?: boolean },
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

  const points = useMemo(() => run?.points || [], [run?.points]);
  const stats = run?.stats || {};
  const updatedAt = run ? Date.parse(run.updated_at) : NaN;
  const quietMs = Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : 0;
  const ended = !run || run.status === "ended";
  const paused = run?.status === "paused";
  // A paused run publishes nothing BY DESIGN — it drops fixes, and the pause was
  // itself pushed through as a status change. So silence after one is expected,
  // not a lost signal: the row already says exactly what is going on, and the
  // freshness line below still reports how old that answer is.
  const quiet = !ended && !paused && quietMs >= QUIET_MS;
  const hasTrack = points.some(Boolean);

  // Chart data, straight off the published points — per-point altitude and
  // timestamps already ride every upload, so nothing new crosses the wire.
  // flat[i] is the SAME point as series[i] (both walk flattenTrack in order),
  // which is what makes the chart→map cursor link below a plain index.
  const derived = useMemo(() => {
    const series = points.length ? buildRunSeries(points) : [];
    return {
      series,
      flat: points.length ? flattenTrack(points) : [],
      hasElev: series.some(r => r.elevM != null),
      elevGain: Math.round(elevGainM(points)),
    };
  }, [points]);
  const { series, flat, hasElev, elevGain } = derived;
  // Two rows is the floor for a line worth drawing; a run that just started
  // keeps the compact stats-only panel instead of an empty chart frame.
  const hasChart = series.length >= 2;

  const [cursor, setCursor] = useState<number | null>(null);
  const active = cursor != null && cursor >= 0 && cursor < flat.length ? cursor : null;
  const highlight = active != null ? { lat: flat[active].lat, lng: flat[active].lng } : null;
  const onCursor = useCallback((i: number | null) => setCursor(i), []);

  // Current pace only means something while the run is moving: an ended or
  // paused run's last window is history, not "now".
  const showCurPace = !ended && !paused && stats.curPace != null;

  // Report the derived state up so the caller's header can show the same dot
  // without recomputing (and re-deriving) it. Effect rather than render-time so
  // the parent's setState never lands during this component's render.
  useEffect(() => { onStatus?.({ ended, paused, quiet, hasTrack }); }, [ended, paused, quiet, hasTrack, onStatus]);

  const freshness = () => {
    if (!Number.isFinite(updatedAt)) return "";
    const secs = Math.round(quietMs / 1000);
    if (secs < 15) return t("liveShare.watch.updatedNow");
    if (secs < 60) return t("liveShare.watch.updatedSecs", { secs });
    return t("liveShare.watch.updatedMins", { mins: Math.round(secs / 60) });
  };

  const statusLine = ended ? (
    <p className="text-sm text-center text-slate-400">{t("liveShare.watch.ended")}</p>
  ) : quiet ? (
    <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs leading-snug text-amber-100 text-center">
      {t("liveShare.watch.signalLost")}
    </p>
  ) : (
    <p className="text-[11px] text-center text-slate-500">
      {paused ? t("liveShare.watch.paused") + " · " : ""}{freshness()}
    </p>
  );

  return (
    <div className="flex-1 min-h-0 @container flex flex-col @3xl:flex-row">
      <div className="flex-1 min-h-0 relative">
        <RouteMap points={points} follow={!ended} endpoints={ended && hasTrack} highlight={highlight}
          interactive className="h-full w-full" style={{}} />
        {!hasTrack && (
          <div className="absolute inset-x-0 bottom-3 flex justify-center pointer-events-none">
            <span className="rounded-full bg-slate-900/85 border border-slate-700 px-3 py-1.5 text-xs text-slate-300">
              {t("liveShare.watch.waiting")}
            </span>
          </div>
        )}
      </div>

      {/* Beside the map when the container is wide, below it when narrow. The
          panel scrolls on its own so a tall chart can never squeeze the map away
          on a phone. */}
      <div className="border-t border-slate-800 max-h-[55%] overflow-y-auto shrink-0
          @3xl:border-t-0 @3xl:border-l @3xl:w-96 @3xl:max-h-none"
        style={bottomInset ? { paddingBottom: "var(--safe-bottom)" } : undefined}>
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <Stat label={t("liveShare.watch.stats.distance")} value={(stats.km ?? 0).toFixed(2)} />
            <Stat label={t("liveShare.watch.stats.time")}
              value={fmt.dur(stats.durationSec ?? 0) === "--" ? "0:00" : fmt.dur(stats.durationSec ?? 0)} />
            <Stat label={t("liveShare.watch.stats.pace")} value={fmt.pace(Math.round(stats.avgPace ?? 0))} />
          </div>
          {(showCurPace || hasElev) && (
            <div className={"grid gap-2 " + (showCurPace && hasElev ? "grid-cols-2" : "grid-cols-1")}>
              {showCurPace && <Stat label={t("liveShare.watch.stats.curPace")} value={fmt.pace(Math.round(stats.curPace ?? 0))} />}
              {hasElev && <Stat label={t("liveShare.watch.stats.elevGain")} value={elevGain + " m"} />}
            </div>
          )}

          {hasChart && (
            <div className="bg-slate-800 rounded-2xl p-3 space-y-2">
              <RunChart series={series} show={{ elev: true, pace: true, hr: false }}
                hasElev={hasElev} hasHr={false} onCursor={onCursor} />
              <Readout row={active != null ? series[active] : null} hasHr={false} hasElev={hasElev} />
            </div>
          )}

          {statusLine}
        </div>
      </div>
    </div>
  );
}
