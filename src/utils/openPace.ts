// The pace an open plan (no race, so no goal time) trains from: the runner's own
// goal time when set, else what their last two months of running project to at
// the plan's distance, else the mid-pack suggestion. docs/training-plan.md.
import { clampGoalSec, suggestedGoalSec } from "./goal";
import { BEST_EFFORT_DISTANCES, effortsFor } from "./bestEfforts";
import { bestEffortAnchor, riegel } from "./predictions";
import { ymd } from "./format";
import { isCrossTraining } from "../types";
import type { PaceSource } from "../types";

export const ANCHOR_WINDOW_DAYS = 56;
// Efforts shorter than this are a blip, not a measure of fitness (as in bestEffortAnchor).
const MIN_EFFORT_KM = 3;

type AnchorRun = {
  date?: string; km?: number; type?: string; durationSec?: number; elevation?: number | null;
  bestEfforts?: Record<string, number>;
};

const recentRunning = (runs: AnchorRun[] | undefined, today: Date) => {
  const from = new Date(today); from.setDate(from.getDate() - ANCHOR_WINDOW_DAYS);
  const cutoff = ymd(from);
  return (runs || []).filter(r => r && r.date && r.date >= cutoff && (r.km ?? 0) > 0 && !isCrossTraining(r));
};

// The fastest finish time the runner's recent efforts project to at `distanceKm`
// (Riegel), or null with nothing to go on. Standard-distance efforts first (a
// measured 10K is better evidence than an average pace); runs of 3 km or more
// stand in when none exists.
export function anchorGoalSec(runs: AnchorRun[] | undefined, distanceKm: number, today: Date = new Date()): number | null {
  const recent = recentRunning(runs, today);
  let best = Infinity;
  for (const r of recent) {
    const efforts = effortsFor(r);
    for (const { key, km } of BEST_EFFORT_DISTANCES) {
      const sec = efforts[key];
      if (sec == null || km < MIN_EFFORT_KM) continue;
      best = Math.min(best, riegel(sec, km, distanceKm));
    }
  }
  if (best === Infinity) {
    const a = bestEffortAnchor(recent.map(r => ({ km: r.km ?? 0, durationSec: r.durationSec, elevation: r.elevation, type: r.type })));
    if (a) best = riegel(a.durationSec, a.km, distanceKm);
  }
  return best < Infinity ? clampGoalSec(Math.round(best), distanceKm) : null;
}

export function resolveOpenPace(
  goalSec: unknown, distanceKm: number, runs: AnchorRun[] | undefined, today: Date = new Date(),
): { goalSec: number; source: PaceSource } {
  const given = Number(goalSec);
  if (given > 0) return { goalSec: given, source: "goal" };
  const anchor = anchorGoalSec(runs, distanceKm, today);
  if (anchor) return { goalSec: anchor, source: "anchor" };
  return { goalSec: suggestedGoalSec(distanceKm) || Math.round(distanceKm * 390), source: "suggested" };
}
