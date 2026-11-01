import { startOfDay } from "./plan";
import { ymd } from "./format";
import { mainRace } from "./planPhase";
import { goalKind } from "./recovery";
import type { Plan, PlanSession } from "../types";

// Plan-session selection for the Dashboard; both selectors carry the week number for toggleSess/skipSess/goLog.
// An untouched session is "overdue", not "missed": copy stays forgiving (badges.ts holds the same line).
// Overdue is DERIVED, never stored, so a plan rebuild can't leave a stale flag behind.
export type SessionWithWeek = PlanSession & { wNum: number };

// How far back an untouched session stays actionable. Rebuilds keep elapsed weeks (carryProgress), so
// without a floor every retained week would read as still open. Two weeks is where "still open" is true.
export const OVERDUE_LOOKBACK_DAYS = 14;

const withWeek = (plan: Plan | null): SessionWithWeek[] =>
  plan?.weeks?.length
    ? plan.weeks.flatMap(w => w.sessions.map(s => ({...s, wNum: w.weekNumber} as SessionWithWeek)))
    : [];

const untouched = (s: SessionWithWeek) => !s.done && !s.skipped;
const dayOf = (s: SessionWithWeek) => new Date(s.date + "T00:00:00");

// Untouched sessions inside the lookback window, most recent first. Returns every match; capping is the
// caller's call. A race is never overdue (the debrief owns it), and once the main race has passed
// nothing dated on or before it is.
export function overdueSessions(plan: Plan | null, today: Date): SessionWithWeek[] {
  const start = startOfDay(today);
  const floor = startOfDay(today);
  floor.setDate(floor.getDate() - OVERDUE_LOOKBACK_DAYS);
  const todayStr = ymd(start);
  // A rebuild renames the passed race `past-race`, so mainRace no longer sees it.
  const over = [mainRace(plan)?.date, goalKind(plan) !== "race" ? plan?.openedAfter?.race : null, plan?.recovery?.race,
    ...(plan?.weeks ?? []).flatMap(w => w.sessions.filter(s => s.type === "RACE" && s.id === "past-race").map(s => s.date))]
    .filter((d): d is string => !!d && d < todayStr).sort().pop() ?? null;
  return withWeek(plan)
    .filter(s => s.type !== "RACE" && !(over && s.date <= over)
      && untouched(s) && dayOf(s) < start && dayOf(s) >= floor)
    .sort((a, b) => b.date.localeCompare(a.date));
}

// The soonest untouched session dated today or later.
export function nextSession(plan: Plan | null, today: Date): SessionWithWeek | null {
  const start = startOfDay(today);
  return withWeek(plan)
    .filter(s => untouched(s) && dayOf(s) >= start)
    .sort((a, b) => a.date.localeCompare(b.date))[0] || null;
}

// Overdue count per week number, for PlanView's collapsed past-week headers.
export function overdueByWeek(plan: Plan | null, today: Date): Record<number, number> {
  const out: Record<number, number> = {};
  for (const s of overdueSessions(plan, today)) out[s.wNum] = (out[s.wNum] || 0) + 1;
  return out;
}
