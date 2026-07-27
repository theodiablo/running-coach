import { useMemo, useState, useCallback, memo } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { RouteMap } from "../components/RouteMap";
import { EffortRow } from "../components/EffortRow";
import { useDismissable } from "../hooks/useDismissable";
import { useRouteTrace } from "../hooks/useRouteTrace";
import { buildRunSeries } from "../utils/runSeries";
import { buildSplits } from "../utils/runSplits";
import { rankRunEfforts, hasMeasuredEfforts } from "../utils/bestEfforts";
import { timeInZones, effectiveMaxHR, HR_ZONES } from "../utils/hr";
import { flattenTrack, haversineM } from "../utils/geo";
import { activeIndexFromChartState } from "../utils/chartCursor";
import { fmt } from "../utils/format";
import type { HrSample, RunSeriesRow } from "../utils/runSeries";
import type { TrackPointOrGap } from "../utils/geo";
import type { Run, SettingsState } from "../types";

// `runs` is the whole log, used only to rank this run's best efforts against it
// (an in-memory scan — see src/utils/bestEfforts.ts). Optional so a render test
// can mount the modal without one.
type Props = { run: Run; settings: SettingsState; runs?: Run[]; onClose: () => void };

const ELEV_CLR = "#10b981", PACE_CLR = "#38bdf8", HR_CLR = "#f87171";
const tt = { background: "#1e293b", border: "none", borderRadius: 8, color: "#fff", fontSize: 12 };

// One toggle chip for a chart series.
function Chip({ on, color, label, onToggle }: { on: boolean; color: string; label: string; onToggle: () => void }) {
  return (
    <button aria-pressed={on} onClick={onToggle}
      className={"flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors " + (on ? "bg-slate-700 text-white" : "text-slate-500")}>
      <span className="w-2.5 h-2.5 rounded-sm" style={{ background: on ? color : "#475569" }} />
      {label}
    </button>
  );
}

// The combined elevation / pace / HR chart. Extracted + exported so a render
// test can guard the two recharts traps directly: the numeric distance x-axis
// (a categorical axis would evenly space unevenly-spaced post-simplify points)
// and the distinct per-series `yAxisId`s (recharts throws if a series references
// a yAxisId with no matching YAxis).
export const RunChart = memo(function RunChart({ series, show, hasElev, hasHr, onCursor }: {
  series: RunSeriesRow[];
  show: { elev: boolean; pace: boolean; hr: boolean };
  hasElev: boolean;
  hasHr: boolean;
  onCursor?: (i: number | null) => void;
}) {
  const { t } = useTranslation();
  // recharts hands the chart state (with activeTooltipIndex) to move/click;
  // onClick also covers touch taps, where mouse-move never fires.
  const pick = (s: { activeTooltipIndex?: number | string | null } | null | undefined) =>
    onCursor?.(activeIndexFromChartState(s));
  return (
    <ResponsiveContainer width="100%" height={200}>
      <ComposedChart data={series} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}
        onMouseMove={pick} onClick={pick} onMouseLeave={() => onCursor?.(null)}>
        <CartesianGrid strokeDasharray="3 3" stroke="#0f172a" />
        {/* Numeric distance axis: post-simplify points are unevenly spaced in km,
            so a categorical axis would misplace where things happened. */}
        <XAxis dataKey="distKm" type="number" domain={[0, "dataMax"]} allowDecimals={false}
          tick={{ fill: "#475569", fontSize: 10 }} tickFormatter={(v: number) => String(Math.round(v))} />
        {/* Each series pins its OWN yAxisId — recharts silently collapses to a
            single axis if a series' yAxisId is missing. */}
        <YAxis yAxisId="elev" hide domain={["dataMin - 10", "dataMax + 10"]} />
        <YAxis yAxisId="pace" hide reversed domain={["dataMin - 20", "dataMax + 20"]} />
        <YAxis yAxisId="hr" hide domain={["dataMin - 5", "dataMax + 5"]} />
        <Tooltip contentStyle={tt}
          labelFormatter={(v) => t("progress.detail.tooltip.km", { v: Number(v).toFixed(2) })}
          formatter={(value, name) => {
            if (value == null) return ["", ""];
            if (name === "paceSecPerKm") return [t("progress.detail.tooltip.pace", { pace: fmt.pace(Number(value)) }), t("progress.detail.series.pace")];
            if (name === "elevM") return [t("progress.detail.tooltip.elevation", { v: Math.round(Number(value)) }), t("progress.detail.series.elevation")];
            if (name === "hr") return [t("progress.detail.tooltip.hr", { bpm: Math.round(Number(value)) }), t("progress.detail.series.heartRate")];
            return [String(value), String(name)];
          }} />
        {hasElev && show.elev &&
          <Area yAxisId="elev" type="monotone" dataKey="elevM" stroke={ELEV_CLR} fill={ELEV_CLR} fillOpacity={0.15} strokeWidth={1.5} dot={false} connectNulls={false} isAnimationActive={false} />}
        {show.pace &&
          <Line yAxisId="pace" type="monotone" dataKey="paceSecPerKm" stroke={PACE_CLR} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />}
        {hasHr && show.hr &&
          <Line yAxisId="hr" type="monotone" dataKey="hr" stroke={HR_CLR} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />}
      </ComposedChart>
    </ResponsiveContainer>
  );
});

// The highlighted-point readout under the chart. Exported so a render test can
// assert the formatting/omission rules directly. A fixed min-height keeps the
// layout stable when the cursor appears and clears.
export function Readout({ row, hasHr, hasElev }: { row: RunSeriesRow | null; hasHr: boolean; hasElev: boolean }) {
  const { t } = useTranslation();
  return (
    <div aria-live="polite" className="flex flex-wrap items-center gap-x-4 gap-y-1 min-h-[1.75rem] text-sm">
      {row ? (
        <>
          <span className="text-slate-100 font-semibold tabular-nums">{t("progress.detail.tooltip.km", { v: row.distKm.toFixed(2) })}</span>
          <span className="tabular-nums" style={{ color: PACE_CLR }}>
            {row.paceSecPerKm != null ? t("progress.detail.tooltip.pace", { pace: fmt.pace(row.paceSecPerKm) }) : "—"}
          </span>
          {hasElev && (
            <span className="tabular-nums" style={{ color: ELEV_CLR }}>
              {row.elevM != null ? t("progress.detail.tooltip.elevation", { v: Math.round(row.elevM) }) : "—"}
            </span>
          )}
          {hasHr && (
            <span className="tabular-nums" style={{ color: HR_CLR }}>
              {row.hr != null ? t("progress.detail.tooltip.hr", { bpm: Math.round(row.hr) }) : "—"}
            </span>
          )}
        </>
      ) : (
        <span className="text-slate-500">{t("progress.detail.readout.hint")}</span>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-800 rounded-xl p-4">
      <p className="text-slate-400 text-xs">{label}</p>
      <p className="text-white text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}

// Full-screen per-run analytics: route map, a combined elevation/pace/HR chart
// with toggleable series, a per-km split table, an HR time-in-zone card (BLE runs
// only), best efforts, and summary tiles. Self-fetches the trace (kept out of
// the synced blob).
export function RunDetailModal({ run, settings, runs, onClose }: Props) {
  const { t } = useTranslation();
  const { route } = useRouteTrace(run, { withStats: true });
  const [show, setShow] = useState({ elev: true, pace: true, hr: true });
  useDismissable(true, onClose);

  // A GPS trace (map expected) vs. an HR-only import (hrRouteId, no GPS) which
  // has a trace to fetch but no map. The map-shaped loader and the "route
  // unavailable" message are for GPS-expected runs only; HR-only is handled apart.
  const hasGpsTrace = !!(run.routeId || run.routeTmp);
  const maxHR = effectiveMaxHR(settings);
  const restHR = settings.restHR || 60; // match every other zone call site's fallback

  // Derive all chart/table data once per trace change — NOT on every re-render.
  // The modal re-renders on any hub state change (toasts, background scans) and on
  // each toggle-chip click, and these scans are O(points)+O(HR samples); a
  // multi-hour run has thousands of each.
  const derived = useMemo(() => {
    const points = (route?.points ?? []) as unknown as TrackPointOrGap[];
    const hrSamples = (route?.stats?.hrSamples as HrSample[] | undefined) || null;
    const series = points.length ? buildRunSeries(points, hrSamples) : [];
    return {
      hasPoints: points.length > 0,
      series,
      // flat[i] is the SAME point as series[i] (buildRunSeries walks flattenTrack
      // in order, one row per real point) — the backbone of the chart↔map link.
      flat: points.length ? flattenTrack(points) : [],
      splits: points.length ? buildSplits(points, hrSamples) : [],
      zones: timeInZones(hrSamples, maxHR, restHR),
      // HR presence is the RAW stream, not per-point alignment — so the chart HR
      // series and the time-in-zone card agree (a sparse GPS trace could otherwise
      // hide the chart line while the zone card still rendered).
      hasHr: !!(hrSamples && hrSamples.length),
      hasElev: series.some(r => r.elevM != null),
    };
  }, [route, maxHR, restHR]);
  const { hasPoints, series, flat, splits, zones, hasHr, hasElev } = derived;
  const zoneTotal = zones.reduce((s, z) => s + z.sec, 0);

  // Shared chart↔map cursor: the active series/flat index (a single nullable
  // number). Derived during render (not an effect), clamped to the current trace
  // so a cursor left over from a prior run can't index out of range.
  const [cursor, setCursor] = useState<number | null>(null);
  const active = cursor != null && cursor >= 0 && cursor < flat.length ? cursor : null;
  const highlight = active != null ? { lat: flat[active].lat, lng: flat[active].lng } : null;
  const onCursor = useCallback((i: number | null) => setCursor(i), []);
  // Map tap → nearest flattened point (best-effort). Reads the memoised flat array.
  const onPick = useCallback((loc: { lat: number; lng: number }) => {
    const fp = derived.flat;
    if (!fp.length) return;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < fp.length; i++) {
      const d = haversineM(loc, { lat: fp[i].lat, lng: fp[i].lng });
      if (d < bestD) { bestD = d; best = i; }
    }
    setCursor(best);
  }, [derived.flat]);

  const pace = run.km && run.durationSec ? run.durationSec / run.km : 0;

  // Reads the stored `bestEfforts` (or the whole-run estimate for a run that was
  // never measured) — never the fetched trace, so the card renders immediately
  // and identically for a manual run with no trace to fetch.
  const efforts = useMemo(() => rankRunEfforts(run, runs || []), [run, runs]);
  const measured = hasMeasuredEfforts(run);

  const header = (
    <header className="flex items-center justify-between px-4 border-b border-slate-800 shrink-0"
      style={{ height: "calc(44px + var(--safe-top))", paddingTop: "var(--safe-top)" }}>
      <div className="min-w-0">
        <p className="text-white text-sm font-semibold truncate">{fmt.date(run.date)}</p>
        <p className="text-slate-400 text-xs">{run.km + " km · " + fmt.dur(run.durationSec)}</p>
      </div>
      <button onClick={onClose} aria-label={t("common.close")}
        className="flex items-center justify-center text-slate-400 hover:text-white p-1.5 rounded-lg border border-slate-700 hover:border-slate-500 transition-colors">
        <X size={18} />
      </button>
    </header>
  );

  const tiles = (
    <div className="grid grid-cols-2 gap-3">
      <Tile label={t("progress.detail.tiles.distance")} value={run.km + " km"} />
      <Tile label={t("progress.detail.tiles.duration")} value={fmt.dur(run.durationSec)} />
      <Tile label={t("progress.detail.tiles.avgPace")} value={fmt.pace(pace) + "/km"} />
      {!!run.elevation && <Tile label={t("progress.detail.tiles.elevation")} value={run.elevation + " m"} />}
      {!!run.hr && <Tile label={t("progress.detail.tiles.avgHr")} value={t("progress.detail.tooltip.hr", { bpm: run.hr })} />}
      {!!run.hrMax && <Tile label={t("progress.detail.tiles.maxHr")} value={t("progress.detail.tooltip.hr", { bpm: run.hrMax })} />}
    </div>
  );

  return (
    <div className="fixed inset-0 bg-slate-900 z-50 flex flex-col animate-slide-up">
      {header}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 max-w-lg w-full mx-auto"
        style={{ paddingBottom: "calc(1rem + var(--safe-bottom))" }}>

        {/* Map-shaped loader only when a GPS route is actually expected. */}
        {route === undefined && hasGpsTrace && (
          <div className="h-56 rounded-xl bg-slate-800 flex items-center justify-center text-slate-500 text-sm">
            {t("progress.history.loadingRoute")}
          </div>
        )}
        {/* HR-only import (no GPS): a compact loader, not a phantom map box. */}
        {route === undefined && !hasGpsTrace && run.hrRouteId && (
          <div className="rounded-xl bg-slate-800 px-4 py-3 text-slate-500 text-sm text-center">
            {t("progress.history.loadingRoute")}
          </div>
        )}

        {hasPoints && route && (
          <>
            <RouteMap points={route.points} interactive endpoints highlight={highlight} onPick={onPick}
              className="h-56 rounded-xl overflow-hidden" />

            {/* Series toggles + combined chart + highlighted-point readout */}
            <div className="bg-slate-800 rounded-2xl p-4 space-y-3">
              <div className="flex flex-wrap gap-1">
                {hasElev && <Chip on={show.elev} color={ELEV_CLR} label={t("progress.detail.series.elevation")}
                  onToggle={() => setShow(s => ({ ...s, elev: !s.elev }))} />}
                <Chip on={show.pace} color={PACE_CLR} label={t("progress.detail.series.pace")}
                  onToggle={() => setShow(s => ({ ...s, pace: !s.pace }))} />
                {hasHr && <Chip on={show.hr} color={HR_CLR} label={t("progress.detail.series.heartRate")}
                  onToggle={() => setShow(s => ({ ...s, hr: !s.hr }))} />}
              </div>
              <RunChart series={series} show={show} hasElev={hasElev} hasHr={hasHr} onCursor={onCursor} />
              <Readout row={active != null ? series[active] : null} hasHr={hasHr} hasElev={hasElev} />
            </div>
          </>
        )}

        {/* HR time-in-zone. Rendered on the raw HR stream ALONE, not gated on GPS,
            so a watch import with HR but no route (Garmin/Samsung on Health
            Connect) still gets its zone breakdown; the distance-based chart/splits
            above stay GPS-only because they need a distance axis. */}
        {route && zoneTotal > 0 && (
          <div className="bg-slate-800 rounded-2xl p-4">
            <p className="text-slate-400 text-sm font-medium mb-3">{t("progress.detail.zones.title")}</p>
            <div className="flex rounded-lg overflow-hidden h-4 mb-3">
              {zones.map(z => z.sec > 0 && (
                <div key={z.zone} style={{ background: HR_ZONES[z.zone - 1].clr, width: (z.sec / zoneTotal * 100) + "%" }} />
              ))}
            </div>
            <div className="space-y-1">
              {zones.filter(z => z.sec > 0).map(z => (
                <div key={z.zone} className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-2 text-slate-300">
                    <span className="w-2.5 h-2.5 rounded-sm" style={{ background: HR_ZONES[z.zone - 1].clr }} />
                    {t("progress.detail.zones.zone", { n: z.zone })}
                  </span>
                  <span className="text-slate-400 tabular-nums">{fmt.mins(Math.round(z.sec / 60))}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Per-km splits (GPS only — needs a distance axis) */}
        {hasPoints && route && splits.length > 0 && (
          <div className="bg-slate-800 rounded-2xl p-4">
            <p className="text-slate-400 text-sm font-medium mb-3">{t("progress.detail.splits.title")}</p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-500 text-xs text-left">
                  <th className="font-medium pb-2">{t("progress.detail.splits.km")}</th>
                  <th className="font-medium pb-2 text-right">{t("progress.detail.splits.pace")}</th>
                  <th className="font-medium pb-2 text-right">{t("progress.detail.splits.elevation")}</th>
                  {hasHr && <th className="font-medium pb-2 text-right">{t("progress.detail.splits.hr")}</th>}
                </tr>
              </thead>
              <tbody>
                {splits.map(s => (
                  <tr key={s.km} className={"tabular-nums " + (s.fastest ? "text-emerald-400" : s.slowest ? "text-amber-400" : "text-slate-200")}>
                    <td className="py-1">{s.distKm >= 0.999 ? s.km : t("progress.detail.splits.partial", { km: s.distKm.toFixed(2) })}</td>
                    <td className="py-1 text-right">{fmt.pace(s.paceSecPerKm)}</td>
                    <td className="py-1 text-right text-slate-400">{s.elevGainM > 0 ? "+" + s.elevGainM + " m" : "—"}</td>
                    {hasHr && <td className="py-1 text-right text-slate-400">{s.avgHr != null ? s.avgHr : "—"}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Resolved but no map to show: a GPS route that came back empty (Stop
            tapped before any fix, or a failed fetch), or a run with no trace at
            all. Suppressed for an HR-only import (run.hrRouteId) — it never had a
            route, so "route unavailable" would be misleading; its tiles (and zone
            card when the HR loads) are the content, and a failed HR fetch just
            means no zone card, not an error. */}
        {route !== undefined && !hasPoints && !hasHr && !run.hrRouteId && (
          <p className="text-slate-500 text-sm text-center">
            {t(hasGpsTrace ? "progress.history.routeUnavailable" : "progress.detail.noRoute")}
          </p>
        )}

        {tiles}

        {/* Best efforts + where they sit in the log. Not gated on a trace: a
            manually logged 5K still ranks, off its own time. */}
        {efforts.length > 0 && (
          <div className="bg-slate-800 rounded-2xl p-4 space-y-2">
            <p className="text-slate-400 text-sm font-medium">{t("bestEfforts.card.title")}</p>
            {efforts.map(e => <EffortRow key={e.key} effort={e} />)}
            {!measured && <p className="text-slate-500 text-xs">{t("bestEfforts.card.estimated")}</p>}
          </div>
        )}

        {run.notes && <p className="text-slate-400 text-sm">{run.notes}</p>}
      </div>
    </div>
  );
}
