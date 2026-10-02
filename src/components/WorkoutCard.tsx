import { forwardRef } from "react";
import { useTranslation } from "react-i18next";
import { TCLR } from "../constants";
import { isOpenSpec, stepWeights, type WorkoutSpec } from "../utils/workoutSpec";
import { workoutSub, workoutTitle } from "../utils/workoutCopy";
import type { Workout, WorkoutStepKind } from "../utils/workout";

// The recorder's "Today's run" card: what the run is, at a glance. Tapping it
// opens WorkoutSheet before Start; once running the guided panel takes over.

const STEP_BG: Record<WorkoutStepKind, string> = {
  warmup: "bg-emerald-400", cooldown: "bg-emerald-400", work: "bg-orange-400", steady: "bg-orange-400",
  recover: "bg-sky-400", run: "bg-orange-400", walk: "bg-cyan-400",
};

const SPEC_PLAN_TYPE = { regular: "EASY", tempo: "TEMPO", intervals: "INTERVALS", runwalk: "WALK" } as const;

export function WorkoutTimeline({ workout, pace }: { workout: Workout; pace: number | null }) {
  const weights = stepWeights(workout, pace);
  return (
    <div className="flex h-2 gap-0.5 overflow-hidden rounded bg-slate-900" aria-hidden>
      {workout.steps.map((s, i) => (
        <span key={i} className={STEP_BG[s.kind] + (workout.steps.length === 1 && s.m == null && s.sec == null ? " opacity-40" : "")}
          style={{ flex: weights[i] }} />
      ))}
    </div>
  );
}

type WorkoutCardProps = {
  spec: WorkoutSpec;
  workout: Workout;
  hr: { lo: number; hi: number } | null;
  /** The plan session's type, while the runner hasn't changed the kind of run. */
  planType?: string | null;
  edited: boolean;
  onEdit: () => void;
  className?: string;
};

export const WorkoutCard = forwardRef<HTMLButtonElement, WorkoutCardProps>(
  function WorkoutCard({ spec, workout, hr, planType, edited, onEdit, className = "" }, ref) {
    const { t } = useTranslation();
    const typeKey = planType || SPEC_PLAN_TYPE[spec.type];
    const badge = !planType && spec.type === "regular" ? t("tracker.setup.badge.run")
      : spec.type === "runwalk" ? t("tracker.setup.type.runwalk") : t("common.types." + typeKey);
    return (
      <button ref={ref} onClick={onEdit} aria-label={t("tracker.setup.edit")}
        className={"w-full text-left bg-slate-800 hover:bg-slate-700/70 border border-slate-700 rounded-xl px-3 py-2.5 space-y-2 transition-colors " + className}>
        <span className="flex items-center gap-2">
          <span className={"text-[11px] font-bold uppercase tracking-wide " + ((TCLR as Record<string, string>)[typeKey] || "text-slate-300")}>{badge}</span>
          <span className="flex-1 min-w-0 truncate text-sm font-semibold text-white">{workoutTitle(spec, t)}</span>
          <span className="text-xs font-semibold text-orange-300">{t("tracker.setup.editShort")}</span>
        </span>
        {!isOpenSpec(spec) && <WorkoutTimeline workout={workout} pace={spec.pace} />}
        <span className="block text-xs text-slate-400">
          {workoutSub(spec, hr, t)}
          {edited && <span className="text-orange-300"> · {t("tracker.setup.changed")}</span>}
        </span>
      </button>
    );
  });
