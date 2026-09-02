import { isCrossTraining } from "../types";
import type { Plan, PlanSession, PlanWeek, Run } from "../types";
import type { SessionWithWeek } from "./overdue";

// Matching a run the runner already recorded to the plan session it fulfils.
//
// `findOpenPlanSession` (plan.ts) matches on the calendar day alone, at the one
// moment a recorder hands off to the log form. Run Thursday's tempo on Wednesday
// and nothing links the two — the session stayed untickable and the run stayed
// anonymous. These helpers widen that to a window and rank the candidates, but
// they only ever PROPOSE: a link is applied by a confirmed tap, never silently.
//
// All pure. See docs/training-plan.md.

// How far either side of a session a run may sit and still plausibly be it.
// Wide enough for "I moved it a couple of days", short of backfilling a month.
export const MATCH_WINDOW_DAYS = 3;

// A run as stored: `Run.id` is optional only because addRuns mints it on save.
export type SavedRun = Run & { id: string };


const dayOf = (d: string) => Date.parse(d + "T00:00:00");
// Whole days between two YYYY-MM-DD strings. Rounded, so a DST hour can't
// turn a same-day pair into a fraction of a day apart.
export const dayGap = (a: string, b: string) => Math.round((dayOf(a) - dayOf(b)) / 86_400_000);

// A session that could still be settled by a run: nobody has touched it, and a
// race is never "the run you did on Wednesday".
const isOpen = (s: PlanSession) => !s.done && !s.skipped && s.type !== "RACE";

// Runs already claimed by some session. One run settles one session — without
// this, the same Wednesday run could tick off every easy day in the week.
export function claimedRunIds(plan: Plan | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const w of plan?.weeks || [])
    for (const s of w.sessions || []) if (s.runId) out.add(s.runId);
  return out;
}

const eligible = (session: PlanSession, run: Run) =>
  !!run.id
  && !!run.date
  // The running / cross-training line: a bike ride must not tick off a tempo,
  // and a run must not tick off the bike day (src/types.ts, docs/indoor-sessions.md).
  && isCrossTraining(run) === isCrossTraining(session)
  && Math.abs(dayGap(run.date, session.date)) <= MATCH_WINDOW_DAYS;

// How far a run's distance falls from what the session prescribed, as a
// fraction. Cross-training carries km:0 by design, so it ranks on date alone.
const kmError = (session: PlanSession, run: Run) => {
  const target = Number(session.km) || 0;
  if (!target || !run.km) return 0;
  return Math.abs(run.km - target) / target;
};

// Candidate runs for one session, best first: nearest day, then closest to the
// prescribed distance, then most recent. Never includes a run another session
// already claims. A saved run always carries an id (addRuns mints one), and the
// caller needs that to link — so it is part of the returned type.
export function candidateRuns(
  plan: Plan | null | undefined,
  session: PlanSession,
  runs: Run[] | null | undefined,
  limit = 5,
): SavedRun[] {
  if (!session?.date || !isOpen(session)) return [];
  const claimed = claimedRunIds(plan);
  return (runs || [])
    .filter((r): r is SavedRun => !!r.id && eligible(session, r) && !claimed.has(r.id))
    .sort((a, b) =>
      Math.abs(dayGap(a.date, session.date)) - Math.abs(dayGap(b.date, session.date))
      || kmError(session, a) - kmError(session, b)
      || b.date.localeCompare(a.date))
    .slice(0, limit);
}

// The session a freshly recorded run most likely belongs to, for the save-time
// offer. Same ranking, read the other way round: nearest day first, then the
// closest prescription. Returns the session with its week number, or null.
export function bestSessionForRun(
  plan: Plan | null | undefined,
  run: Run | Partial<Run>,
): SessionWithWeek | null {
  if (!run?.date) return null;
  const claimed = claimedRunIds(plan);
  if (run.id && claimed.has(run.id)) return null;
  const open: SessionWithWeek[] = [];
  for (const w of plan?.weeks || [])
    for (const s of w.sessions || [])
      if (isOpen(s) && eligible(s, run as Run)) open.push({ ...s, wNum: w.weekNumber });
  return open.sort((a, b) =>
    Math.abs(dayGap(run.date!, a.date)) - Math.abs(dayGap(run.date!, b.date))
    || kmError(a, run as Run) - kmError(b, run as Run)
    || a.date.localeCompare(b.date))[0] || null;
}

// A plan week owns [startDate, startDate + 7). Re-dating a session outside that
// span would leave it filed under a week it no longer falls in, so the "move the
// session to the day I ran it" offer is only made for a run inside the window.
export function canMoveSessionTo(
  plan: Plan | null | undefined,
  wNum: number,
  date: string,
): boolean {
  const week: PlanWeek | undefined = plan?.weeks?.find(w => w.weekNumber === wNum);
  if (!week?.startDate || !date) return false;
  const off = dayGap(date, week.startDate);
  return off >= 0 && off < 7;
}
