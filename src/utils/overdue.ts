import type { Plan, PlanSession } from "../types";

// Plan-session selection for the Dashboard. Both selectors carry the week number
// so callers can target toggleSess/skipSess/goLog without re-walking the plan.
//
// A session the runner never touched is "overdue", not "missed" — the copy and
// the actions stay forgiving on purpose (src/utils/badges.ts holds the same line
// against streaks). Overdue is DERIVED, never stored: PlanSession has done/
// skipped and nothing else, so a plan rebuild can't leave a stale flag behind.
export type SessionWithWeek = PlanSession & { wNum: number };

const startOfDay = (d: Date) => {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
};

const withWeek = (plan: Plan | null): SessionWithWeek[] =>
  plan?.weeks?.length
    ? plan.weeks.flatMap(w => w.sessions.map(s => ({...s, wNum: w.weekNumber} as SessionWithWeek)))
    : [];

const untouched = (s: SessionWithWeek) => !s.done && !s.skipped;
const dayOf = (s: SessionWithWeek) => new Date(s.date + "T00:00:00");

// Untouched sessions dated before today, most recent first — the freshest miss
// is the one worth acting on. Returns every match; capping is the caller's call
// (the Dashboard shows a few, PlanView counts them all).
export function overdueSessions(plan: Plan | null, today: Date): SessionWithWeek[] {
  const start = startOfDay(today);
  return withWeek(plan)
    .filter(s => untouched(s) && dayOf(s) < start)
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
