// A race's goal time: suggestions from the runner's own log and what a new target goal does to the
// plan's paces. Same projection as Progress → Predictions (best effort, Riegel, grade-adjusted).
import { VERT_COST } from "../constants";
import { bestEffortAnchor, riegel } from "./predictions";
import { addDays } from "./format";
import { isCrossTraining } from "../types";
import type { Plan, Run } from "../types";

export const PREDICT_WINDOW_DAYS = 84;

// Projected finish for a race from the last 12 weeks of running, or null with nothing to anchor on.
export function predictRaceSec(runs: Run[] | null | undefined, km: number, elevation: number, today: string): number | null {
  if (!km) return null;
  const since = addDays(today, -PREDICT_WINDOW_DAYS);
  const recent = (runs || []).filter(r => r.date >= since && r.date <= today && !isCrossTraining(r));
  const best = bestEffortAnchor(recent);
  if (!best) return null;
  return riegel(best.durationSec, best.km, km + VERT_COST * Math.max(0, elevation || 0) / 1000);
}

// Goal times read as round numbers: 5 s steps under an hour, 30 s above.
export function roundGoal(sec: number): number {
  const step = sec < 3600 ? 5 : 30;
  return Math.max(step, Math.round(sec / step) * step);
}

export type GoalSuggestion = { key: "stretch" | "predicted" | "comfortable"; sec: number };

export function goalSuggestions(predictedSec: number | null): GoalSuggestion[] {
  if (!predictedSec) return [];
  return [
    { key: "stretch", sec: roundGoal(predictedSec * 0.97) },
    { key: "predicted", sec: roundGoal(predictedSec) },
    { key: "comfortable", sec: roundGoal(predictedSec * 1.05) },
  ];
}

export type PaceChange = { type: string; before: number; after: number };
const PACE_TYPES = ["EASY", "LONG", "TEMPO", "INTERVALS"] as const;

// Race pace, then the next open session of each type, before and after a rebuild; only rows that move.
export function paceChanges(before: Plan | null | undefined, after: Plan | null | undefined, today: string): PaceChange[] {
  if (!before || !after) return [];
  const out: PaceChange[] = [];
  if (before.racePace && after.racePace && Math.round(before.racePace) !== Math.round(after.racePace)) {
    out.push({ type: "RACE", before: before.racePace, after: after.racePace });
  }
  const nextPace = (plan: Plan, type: string) => {
    for (const w of plan.weeks || []) for (const s of w.sessions || []) {
      if (s.type === type && s.date >= today && !s.done && !s.skipped && s.pace > 0) return s.pace;
    }
    return null;
  };
  for (const type of PACE_TYPES) {
    const b = nextPace(before, type), a = nextPace(after, type);
    if (b && a && Math.round(b) !== Math.round(a)) out.push({ type, before: b, after: a });
  }
  return out;
}
