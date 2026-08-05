// The combined elevation / pace / HR chart and its companions, shared by the
// run-detail modal and the live watch view. Lives in its own file so the lazy
// public watch chunk can import the chart without dragging the whole modal in.

import { memo } from "react";
import { useTranslation } from "react-i18next";
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { activeIndexFromChartState } from "../utils/chartCursor";
import { fmt } from "../utils/format";
import type { RunSeriesRow } from "../utils/runSeries";

export const ELEV_CLR = "#10b981", PACE_CLR = "#38bdf8", HR_CLR = "#f87171";
const tt = { background: "#1e293b", border: "none", borderRadius: 8, color: "#fff", fontSize: 12 };

// One toggle chip for a chart series.
export function Chip({ on, color, label, onToggle }: { on: boolean; color: string; label: string; onToggle: () => void }) {
  return (
    <button aria-pressed={on} onClick={onToggle}
      className={"flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors " + (on ? "bg-slate-700 text-white" : "text-slate-500")}>
      <span className="w-2.5 h-2.5 rounded-sm" style={{ background: on ? color : "#475569" }} />
      {label}
    </button>
  );
}

// Exported so a render test can guard the two recharts traps directly: the
// numeric distance x-axis (a categorical axis would evenly space
// unevenly-spaced post-simplify points) and the distinct per-series `yAxisId`s
// (recharts throws if a series references a yAxisId with no matching YAxis).
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
