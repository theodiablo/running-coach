import { Volume2, VolumeX, Flag } from "lucide-react";
import { useTranslation } from "react-i18next";
import { fmt } from "../utils/format";
import type { GuidedDisplay } from "../hooks/useGuidedWorkout";

// The in-tracker guided-workout card (premium; docs/guided-workouts.md):
// current step + big remaining figure + live pace verdict + next-step preview.
// Pure presentation — all state comes from useGuidedWorkout in LiveRunTracker.

type GuidedWorkoutPanelProps = {
  display: GuidedDisplay;
  muted: boolean;
  onToggleMute: () => void;
  /** Verdict/remaining only mean something mid-run. */
  live: boolean;
};

const KIND_CLR: Record<string, string> = {
  warmup: "text-emerald-400",
  work: "text-orange-400",
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

export function GuidedWorkoutPanel({ display, muted, onToggleMute, live }: GuidedWorkoutPanelProps) {
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

  return (
    <div className="bg-slate-800 rounded-xl px-3 py-2.5 border border-slate-700 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className={"text-xs font-bold uppercase tracking-wide " + (KIND_CLR[display.step.kind] || "text-slate-300")}>
          {display.label}
        </span>
        {display.detail && <span className="text-xs text-slate-400">{display.detail}</span>}
        <span className="flex-1" />
        <button onClick={onToggleMute} aria-pressed={!muted} aria-label={t("tracker.guided.cuesToggle")}
          className={"p-1.5 rounded-lg " + (muted ? "text-slate-500 hover:text-slate-300" : "text-orange-400 hover:text-orange-300")}>
          {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
      </div>
      <div className="flex items-end gap-2.5">
        {remaining != null && (
          <p className="text-3xl font-bold text-white leading-none tabular-nums">{remaining}</p>
        )}
        {live && remaining != null && (
          <p className="text-[11px] text-slate-400 uppercase tracking-wide pb-0.5">{t("tracker.guided.left")}</p>
        )}
        {verdict && (
          <span className={"ml-auto text-[11px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border " + verdict.cls}>
            {t(verdict.key)}
          </span>
        )}
      </div>
      {display.nextLabel && (
        <p className="text-[11px] text-slate-500">{t("tracker.guided.next", { step: display.nextLabel })}</p>
      )}
    </div>
  );
}
