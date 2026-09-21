// Which distances the race predictions actually project to. A fixed 5/10/20
// ladder answers a question nobody asked — it prints a 5 km for someone racing
// 14.5 km next week and misses their race entirely. The runner's own upcoming
// races come first; the ladder survives underneath as the general picture.
import type { Participation, SettingsState } from "../types";

export type RaceTarget = {
  key: string;
  label: string;
  date: string;
  distanceKm: number;
  elevation: number;
  // Distinguishes "flat" from "we don't know": a trail race projected as flat
  // reads absurdly optimistic, so the card has to say which one it is.
  elevationKnown: boolean;
  daysAway: number;
  isGoal: boolean;
};

// Most a runner can act on at once; the rest stay on the Races tab.
export const MAX_RACE_TARGETS = 4;

const dayMs = 86400000;

// Whole days from `today` to `date`, both YYYY-MM-DD. Local midnight on each
// side, so a race today is 0 rather than a rounding away from -1.
export const daysBetween = (today: string, date: string) =>
  Math.round((new Date(date + "T00:00:00").getTime() - new Date(today + "T00:00:00").getTime()) / dayMs);

// The plan's target race. `targetEditionId` names it outright; a hand-entered
// main race has no catalogue edition, so it falls back to the settings the plan
// was built from — same reasoning as RacesView's `inPlannable`.
const isGoalRace = (p: Participation, s: Pick<SettingsState, "targetEditionId" | "raceDate" | "distanceKm">) => {
  if (s.targetEditionId) return p.editionId === s.targetEditionId;
  return !!s.raceDate && p.raceDate === s.raceDate && Number(p.distanceKm) === Number(s.distanceKm);
};

// Upcoming races as prediction targets, soonest first. `elevationOf` resolves an
// edition's climb (the catalogue, in the app) and returns null when it has none
// on record — undecided, not flat. The goal race's own `raceElevation` setting
// wins over the catalogue: it's the number the plan was built against.
export function raceTargets(
  participations: Participation[] | null | undefined,
  settings: Pick<SettingsState, "targetEditionId" | "raceDate" | "distanceKm" | "raceElevation">,
  today: string,
  elevationOf: (editionId?: string | null) => number | null = () => null,
): RaceTarget[] {
  const listed = (participations || [])
    .filter(p => p.status === "wishlist" && p.raceDate && Number(p.distanceKm) > 0 && String(p.raceDate) >= today)
    .map(p => {
      const goal = isGoalRace(p, settings);
      const own = goal ? Number(settings.raceElevation) || 0 : 0;
      const known = own > 0 ? own : elevationOf(p.editionId);
      return {
        key: String(p.editionId || p.raceDate) + ":" + p.distanceKm,
        label: String(p.label || ""),
        date: String(p.raceDate),
        distanceKm: Number(p.distanceKm),
        elevation: known ?? 0,
        elevationKnown: known != null,
        daysAway: daysBetween(today, String(p.raceDate)),
        isGoal: goal,
      };
    });

  // A race entered in Plan setup and never added to the Races tab has no
  // participation to find. It is still the race being trained for, so it gets a
  // card from the settings alone — dropping it would lose the one row the old
  // fixed ladder did get right.
  const planDate = String(settings.raceDate || "");
  const planKm = Number(settings.distanceKm) || 0;
  if (planDate >= today && planKm > 0 && !listed.some(t => t.isGoal)) {
    const gain = Number(settings.raceElevation) || 0;
    listed.push({
      key: "plan:" + planDate,
      label: "",
      date: planDate,
      distanceKm: planKm,
      elevation: gain,
      elevationKnown: gain > 0,
      daysAway: daysBetween(today, planDate),
      isGoal: true,
    });
  }

  const sorted = listed.sort((a, b) => a.date.localeCompare(b.date));
  const kept = sorted.slice(0, MAX_RACE_TARGETS);
  // The goal race is usually the furthest away — the A race a block builds to —
  // so a plain slice is exactly what would drop it. It keeps its place.
  const goal = sorted.find(t => t.isGoal);
  if (goal && !kept.includes(goal)) kept.splice(MAX_RACE_TARGETS - 1, 1, goal);
  return kept;
}

// The two estimates against the goal the plan was built on. `over` is the honest
// direction: a projection slower than the goal means the goal is not yet covered.
export type GoalGap = { goalSec: number; diffSec: number; over: boolean };

export function goalGap(
  settings: Pick<SettingsState, "goalSec" | "distanceKm">,
  target: RaceTarget,
  predictedSec: number,
): GoalGap | null {
  const goalSec = Number(settings.goalSec) || 0;
  // The goal belongs to the distance the plan was built for; offering it against
  // a tune-up race of another length would compare two different things.
  if (!goalSec || !target.isGoal || Number(settings.distanceKm) !== target.distanceKm) return null;
  const diffSec = Math.round(predictedSec - goalSec);
  return { goalSec, diffSec, over: diffSec > 0 };
}
