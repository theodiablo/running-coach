// "What's next?": the recap of the block just trained, how the runner feels
// about running, and the goals offered in the order that answer suggests.
// Pure; WhatsNextSheet renders it. docs/races.md.
import { haversineM } from "./geo";
import { effortsFor, type BestEffortKey } from "./bestEfforts";
import { raceKey } from "./openPlan";
import { goalKind } from "./recovery";
import { upcomingRace } from "./raceDay";
import { DEBRIEF_ASK_DAYS, type PhaseInfo } from "./planPhase";
import { isCrossTraining } from "../types";
import type { JoinedEdition, Participation, Plan, Run } from "../types";

export type WhatsNextVariant = "afterRace" | "raceFirst" | "manual";
export type Feeling = "fired" | "steady" | "breather";
export type GoalOption = "race" | "improve" | "lighter";

export const FEELINGS: Feeling[] = ["fired", "steady", "breather"];

// A wishlisted race leads the suggestions only with this many days to train.
export const LEAD_MIN_DAYS = 21;
// Catalogue suggestions: 6 to 24 weeks out.
export const SUGGEST_MIN_DAYS = 42;
export const SUGGEST_MAX_DAYS = 168;
export const SUGGEST_COUNT = 3;

// The goals offered, first = the one the answer points at. The race-first
// variant (a live-first runner, asked straight after their race) skips the
// feeling question and leads with races.
export function goalOrder(feeling: Feeling | null, variant: WhatsNextVariant): GoalOption[] {
  if (variant === "raceFirst" || feeling === "fired" || feeling === null) return ["race", "improve"];
  if (feeling === "steady") return ["improve", "race"];
  return ["lighter", "improve"];
}

const shift = (date: string, n: number) => {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) =>
  Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000);

// ── Recap ────────────────────────────────────────────────────────────────────

export type BlockRecap = {
  from: string;
  to: string;
  sessionsDone: number;
  sessionsPlanned: number;
  km: number;
  longestKm: number;
  runs: number;
};

type RecapInput = {
  plan: Plan | null | undefined;
  runs: Run[] | null | undefined;
  today: string;
  // The race this block led to: the recap stops the day before it and leaves the race run out.
  race?: { date: string; runId?: string | null } | null;
};

// How the training block went (the race is not part of it). A race plan's
// block is the plan up to race day; an open plan's is its last four weeks.
export function blockRecap({ plan, runs, today, race }: RecapInput): BlockRecap | null {
  const weeks = (plan?.weeks || []).filter(w => w.phase !== "RECOVERY" && w.startDate);
  if (!plan || !weeks.length) return null;
  const open = goalKind(plan) !== "race";
  const to = race ? shift(race.date, -1) < today ? shift(race.date, -1) : today : today;
  let from = weeks[0].startDate as string;
  if (open) {
    const trail = shift(today, -28);
    if (from < trail) from = trail;
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
    runs: mine.length,
  };
}

// ── Races to offer ───────────────────────────────────────────────────────────

// The wishlisted race to lead with: the soonest one still far enough away to train for.
export function wishlistLead(parts: Participation[] | undefined, today: string): Participation | null {
  return upcomingRace((parts || []).filter(p => p.raceDate && daysBetween(today, p.raceDate) >= LEAD_MIN_DAYS), today);
}

type Fix = { lat: number; lng: number };
export type Suggestion = { e: JoinedEdition; distM: number | null };

// Catalogue editions 6-24 weeks out, near the distance just raced (any standard
// distance when unknown), not already on the list; nearest first when the
// runner's position is known, else soonest.
export function raceSuggestions(
  editions: JoinedEdition[], opts: { today: string; km: number; listed: Participation[]; loc?: Fix | null },
): Suggestion[] {
  const { today, km, listed, loc } = opts;
  const skip = new Set(listed.map(p => p.editionId).filter(Boolean));
  const near = (d: number) => km > 0
    ? Math.abs(d - km) <= Math.max(1.5, km * 0.25)
    : [5, 10, 21.1, 42.2].some(s => Math.abs(d - s) <= s * 0.12);
  const rows = editions.filter(e => {
    const days = daysBetween(today, e.edition.date);
    return days >= SUGGEST_MIN_DAYS && days <= SUGGEST_MAX_DAYS && near(Number(e.edition.distanceKm)) && !skip.has(e.edition.id);
  }).map(e => ({
    e, distM: loc && e.lat != null && e.lng != null ? haversineM(loc, { lat: e.lat as number, lng: e.lng as number }) : null,
  }));
  rows.sort((a, b) => loc
    ? (a.distM ?? Infinity) - (b.distM ?? Infinity) || a.e.edition.date.localeCompare(b.e.edition.date)
    : a.e.edition.date.localeCompare(b.e.edition.date));
  return rows.slice(0, SUGGEST_COUNT);
}

// ── When it shows ────────────────────────────────────────────────────────────

// Home offers the sheet by itself once, in the weeks after the race: choosing,
// not yet answered, and the race (plus its recovery) at most 28 days back.
export function whatsNextDue(info: PhaseInfo | null, plan: Plan | null | undefined, answeredFor: string | undefined, today: string): boolean {
  if (!info || info.phase !== "choosing" || raceKey(info.race) === answeredFor) return false;
  const rec = plan?.recovery;
  const recoveryDays = rec?.race ? Math.max(0, daysBetween(rec.race, rec.until)) : 0;
  return daysBetween(info.race.date, today) <= DEBRIEF_ASK_DAYS + recoveryDays;
}

// "Faster at": the distances offered and the runner's best effort at each.
export const FASTER_OPTIONS: { key: BestEffortKey; km: number }[] = [
  { key: "5k", km: 5 }, { key: "10k", km: 10 }, { key: "hm", km: 21.0975 },
];

export function bestSecByKey(runs: Run[] | null | undefined): Partial<Record<BestEffortKey, number>> {
  const best: Partial<Record<BestEffortKey, number>> = {};
  for (const r of runs || []) {
    const e = effortsFor(r);
    for (const { key } of FASTER_OPTIONS) {
      const sec = e[key];
      if (sec != null && (best[key] == null || sec < best[key]!)) best[key] = sec;
    }
  }
  return best;
}
