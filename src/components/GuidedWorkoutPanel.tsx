import { Flag } from "lucide-react";
import { useTranslation } from "react-i18next";
import { fmt } from "../utils/format";
import type { GuidedDisplay } from "../hooks/useGuidedWorkout";

// The in-run guided card (docs/guided-workouts.md): current step + big
// remaining figure + live pace / heart-rate verdicts + next-step preview.
// Pure presentation — all state comes from useGuidedWorkout in LiveRunTracker.

type GuidedWorkoutPanelProps = {
  display: GuidedDisplay;
  /** Verdict/remaining only mean something mid-run. */
  live: boolean;
  hr?: { lo: number; hi: number } | null;
};

const KIND_CLR: Record<string, string> = {
  warmup: "text-emerald-400",
  work: "text-orange-400",
  steady: "text-orange-400",
  recover: "text-sky-400",
  cooldown: "text-emerald-400",
  run: "text-orange-400",
  walk: "text-cyan-400",
};

const VERDICT = {
  on:   { cls: "bg-emerald-500/15 border-emerald-500/40 text-emerald-300", key: "tracker.guided.pace.on" },
  slow: { cls: "bg-sky-500/15 border-sky-500/40 text-sky-300",             key: "tracker.guided.pace.slow" },
  fast: { cls: "bg-amber-500/15 border-amber-500/40 text-amber-300",       key: "tracker.guided.pace.fast" },
};

export function GuidedWorkoutPanel({ display, live, hr }: GuidedWorkoutPanelProps) {
  const { t } = useTranslation();

  if (display.finished) {
    return (
      <div className="bg-slate-800 rounded-xl px-3 py-2.5 border border-emerald-500/40 flex items-center gap-2.5">
        <Flag size={16} className="text-emerald-400 shrink-0" />
        <p className="flex-1 text-sm text-emerald-200">{t("tracker.guided.done")}</p>
      </div>
    );
  }

  const remaining = display.remaining.m != null
    ? (display.remaining.m >= 1000 ? (display.remaining.m / 1000).toFixed(2) + " km" : display.remaining.m + " m")
    : display.remaining.sec != null ? fmt.dur(display.remaining.sec)
    : null;
  const verdict = live && display.verdict ? VERDICT[display.verdict] : null;
  const step = display.step;
  const targets = [step.pace ? fmt.pace(step.pace) + "/km" : "", step.hrHi != null && hr ? `${hr.lo}-${hr.hi} bpm` : ""].filter(Boolean).join(" · ");

  return (
    <div className="bg-slate-800 rounded-xl px-3 py-2.5 border border-slate-700 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className={"text-xs font-bold uppercase tracking-wide " + (KIND_CLR[step.kind] || "text-slate-300")}>
          {display.label}
        </span>
        {display.detail && <span className="text-xs text-slate-400 truncate">{display.detail}</span>}
        <span className="flex-1" />
        {verdict && (
          <span className={"text-[11px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border " + verdict.cls}>
            {t(verdict.key)}
          </span>
        )}
        {live && display.hrHigh && (
          <span className="text-[11px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border bg-red-500/15 border-red-500/40 text-red-300">
            {t("tracker.guided.hrHigh")}
          </span>
        )}
      </div>
      {remaining != null && (
        <div className="flex items-end gap-2.5">
          <p className="text-3xl font-bold text-white leading-none tabular-nums">{remaining}</p>
          {live && <p className="text-[11px] text-slate-400 uppercase tracking-wide pb-0.5">{t("tracker.guided.left")}</p>}
          {targets && <p className="ml-auto text-[11px] text-slate-400 pb-0.5">{targets}</p>}
        </div>
      )}
      {remaining == null && targets && <p className="text-[11px] text-slate-400">{t("tracker.guided.target", { targets })}</p>}
      {display.nextLabel && (
        <p className="text-[11px] text-slate-500">{t("tracker.guided.next", { step: display.nextLabel })}</p>
      )}
    </div>
  );
}
