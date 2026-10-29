// Recovery after the race: the rules and the ONE date rule for the validator,
// the runner's plan edits and the coach's tools. Plain dependency-free ESM like
// validation.mjs (imported by Deno and by the Vite app / Vitest); the app's
// typed wrapper is src/utils/recovery.ts. Detail: docs/training-plan.md.

import { addDays } from "./weeks.mjs";

// By distance raced: `days` of easy-only running counted from race day, the
// first `rest` of them with no session at all.
export const RECOVERY_RULES = [
  { maxKm: 7.5, days: 4, rest: 1 },
  { maxKm: 16, days: 6, rest: 2 },
  { maxKm: 30, days: 12, rest: 2 },
  { maxKm: 45, days: 21, rest: 3 },
  { maxKm: Infinity, days: 26, rest: 4 },
];

// Over this, a new plan's first training week carries no quality.
export const FIRST_WEEK_BACK_KM = 16;

export const recoveryRule = (km) => {
  const d = Number(km) || 0;
  return RECOVERY_RULES.find(r => d <= r.maxKm) || RECOVERY_RULES[RECOVERY_RULES.length - 1];
};

// Absent goal = a race plan: every plan written before goals existed.
export const goalKind = (plan) => {
  const k = plan && plan.goal && plan.goal.kind;
  return k === "block" || k === "open" ? k : "race";
};

const inWindow = (r, date) => !!r && typeof r.race === "string" && date > r.race && date <= r.until;

// Inside a recovery: after the plan's own race, after the race a plan opened
// behind, or in a RECOVERY week.
export const inRecovery = (plan, date) =>
  inWindow(plan && plan.recovery, date) || inWindow(plan && plan.openedAfter, date) ||
  !!(plan && Array.isArray(plan.weeks) && plan.weeks.some(w => w && w.phase === "RECOVERY" &&
    typeof w.startDate === "string" && date >= w.startDate && date < addDays(w.startDate, 7)));

// Whether training may sit on `date`: before race day always, race day never,
// after it only inside the recovery the plan was written with, past its rest days
// (a session already run there is history, so `settled` waives the rest days).
export const canHoldTraining = (plan, date, settled = false) => {
  if (goalKind(plan) !== "race") return true;
  const race = String(plan.raceDate || "");
  if (date < race) return true;
  if (date === race) return false;
  return !!plan.recovery && date <= plan.recovery.until && (settled || date > addDays(race, recoveryRule(plan.recovery.km).rest));
};
