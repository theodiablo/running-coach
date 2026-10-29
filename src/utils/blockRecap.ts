// How a training block went: sessions done, distance run, the longest run and
// the easy-pace trend. Pure; the "What's next?" sheet and Home's "Block n done"
// row render it. The easy pace claims no more than the log supports: at the same
// heart rate when the runs carry one, else a plain median with no HR claim.
// docs/races.md, docs/race-predictions.md.
import { effectiveMaxHR } from "./hr";
import { PRIOR_PACE_PER_RESERVE, flatEqKm } from "./predictions";
import { goalKind } from "./recovery";
import { isCrossTraining } from "../types";
import type { Plan, PlanWeek, Run, SettingsState } from "../types";

// Easy runs needed in each end of the block before a trend is shown, and the
// weeks an end spans (at most TREND_WEEKS, at least TREND_MIN_WEEKS, never overlapping).
export const TREND_MIN_RUNS = 3;
export const TREND_WEEKS = 3;
const TREND_MIN_WEEKS = 2;
// Home's "Block n done" row stays this many days after the checkpoint run.
export const BLOCK_DONE_DAYS = 10;

// Seconds per km at the start and the end of the block; atHr is the heart rate
// both are normalised to, null when the runs had none (no same-effort claim).
export type EasyPace = { from: number; to: number; atHr: number | null };

export type BlockRecap = {
  from: string;
  to: string;
  sessionsDone: number;
  sessionsPlanned: number;
  km: number;
  longestKm: number;
  runs: number;
  easyPace: EasyPace | null;
};

type RecapInput = {
  plan: Plan | null | undefined;
  runs: Run[] | null | undefined;
  today: string;
  // The race this block led to: the recap stops the day before it and leaves the race run out.
  race?: { date: string; runId?: string | null } | null;
  // An explicit window (a finished open block) instead of the plan's own.
  span?: { from: string; to: string } | null;
  settings?: Partial<Pick<SettingsState, "maxHR" | "restHR" | "birthYear" | "age">>;
};

const shift = (date: string, n: number) => {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) =>
  Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000);

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

type EasyRun = { date: string; pace: number; hr: number | null };

// Easy pace at the start vs the end of the block, taper left out. Both halves
// need TREND_MIN_RUNS runs, or there is no line. With a heart-rate profile and
// that many easy runs carrying one on each side, every pace is moved to the
// block's median HR along the prior slope (a hotter run is slowed, a cooler one
// sped up), so a faster easy run that was only a harder one does not read as fitness.
function easyTrend(weeks: PlanWeek[], from: string, to: string, runs: Run[], settings: RecapInput["settings"]): EasyPace | null {
  const lead = weeks.filter(w => w.startDate && w.phase !== "TAPER" && w.phase !== "RACE"
    && shift(w.startDate, 6) >= from && w.startDate <= to);
  const k = Math.min(TREND_WEEKS, lead.length >> 1);
  if (k < TREND_MIN_WEEKS) return null;
  const startOf = (w: PlanWeek) => w.startDate as string;
  const early = { from: from > startOf(lead[0]) ? from : startOf(lead[0]), to: shift(startOf(lead[k - 1]), 6) };
  const lastEnd = shift(startOf(lead[lead.length - 1]), 6);
  const late = { from: startOf(lead[lead.length - k]), to: lastEnd < to ? lastEnd : to };
  const easy: EasyRun[] = runs.filter(r => String(r.type).toUpperCase() === "EASY" && (Number(r.durationSec) || 0) > 0)
    .map(r => ({ date: r.date, pace: (r.durationSec as number) / flatEqKm(r), hr: Number(r.hr) > 0 ? Number(r.hr) : null }));
  const side = (list: EasyRun[], span: { from: string; to: string }) => list.filter(r => r.date >= span.from && r.date <= span.to);

  const effMax = settings ? effectiveMaxHR(settings) : 0;
  const hrr = effMax - (settings?.restHR || 60);
  const withHr = easy.filter(r => r.hr != null);
  if (hrr > 0 && side(withHr, early).length >= TREND_MIN_RUNS && side(withHr, late).length >= TREND_MIN_RUNS) {
    const used = [...side(withHr, early), ...side(withHr, late)];
    const atHr = median(used.map(r => r.hr as number));
    const slope = -PRIOR_PACE_PER_RESERVE * median(used.map(r => r.pace)) / hrr;
    const norm = (list: EasyRun[]) => Math.round(median(list.map(r => r.pace + slope * (atHr - (r.hr as number)))));
    return { from: norm(side(withHr, early)), to: norm(side(withHr, late)), atHr: Math.round(atHr) };
  }
  if (side(easy, early).length >= TREND_MIN_RUNS && side(easy, late).length >= TREND_MIN_RUNS)
    return { from: Math.round(median(side(easy, early).map(r => r.pace))), to: Math.round(median(side(easy, late).map(r => r.pace))), atHr: null };
  return null;
}

// How the training block went (the race is not part of it). A race plan's
// block is the plan up to race day; an open plan's is its last four weeks.
export function blockRecap({ plan, runs, today, race, span, settings }: RecapInput): BlockRecap | null {
  const weeks = (plan?.weeks || []).filter(w => w.phase !== "RECOVERY" && w.startDate);
  if (!plan || !weeks.length) return null;
  let from: string;
  let to: string;
  if (span) ({ from, to } = span);
  else {
    to = race ? shift(race.date, -1) < today ? shift(race.date, -1) : today : today;
    from = weeks[0].startDate as string;
    if (goalKind(plan) !== "race") {
      const trail = shift(today, -28);
      if (from < trail) from = trail;
    }
  }
  if (from > to) return null;
  const sessions = weeks.flatMap(w => w.sessions)
    .filter(s => s.date >= from && s.date <= to && s.type !== "RACE" && !s.skipped);
  const mine = (runs || []).filter(r => r.date >= from && r.date <= to && !isCrossTraining(r)
    && String(r.type).toUpperCase() !== "RACE" && r.id !== race?.runId && (Number(r.km) || 0) > 0);
  if (!sessions.length && !mine.length) return null;
  const km = mine.reduce((t, r) => t + (Number(r.km) || 0), 0);
  return {
    from, to, sessionsDone: sessions.filter(s => s.done).length, sessionsPlanned: sessions.length,
    km: Math.round(km * 10) / 10, longestKm: Math.round(Math.max(0, ...mine.map(r => Number(r.km) || 0)) * 10) / 10,
    runs: mine.length, easyPace: easyTrend(weeks, from, to, mine, settings),
  };
}

// The open-plan block whose checkpoint run was done in the last BLOCK_DONE_DAYS:
// the 1-based block and its window, for Home's "Block n done" row.
export function finishedBlock(plan: Plan | null | undefined, today: string): { block: number; from: string; to: string } | null {
  const g = plan?.goal;
  if (!plan || goalKind(plan) === "race" || !g?.startDate) return null;
  const per = Number(g.blockWeeks) > 0 ? Number(g.blockWeeks) : 4;
  const done = plan.weeks.flatMap(w => w.sessions)
    .filter(s => s.sd?.kind === "checkpoint" && s.done && s.date <= today && daysBetween(s.date, today) <= BLOCK_DONE_DAYS)
    .map(s => s.date).sort().pop();
  if (!done) return null;
  const block = Math.floor(daysBetween(g.startDate, done) / (per * 7)) + 1;
  if (block < 1) return null;
  const from = shift(g.startDate, (block - 1) * per * 7);
  const end = shift(from, per * 7 - 1);
  return { block, from, to: end < today ? end : today };
}
