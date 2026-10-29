// "What's next?": how the runner feels about running, and the goals offered in
// the order that answer suggests. The block recap is blockRecap.ts.
// Pure; WhatsNextSheet renders it. docs/races.md.
import { haversineM } from "./geo";
import { effortsFor, type BestEffortKey } from "./bestEfforts";
import { raceKey } from "./openPlan";
import { upcomingRace } from "./raceDay";
import { DEBRIEF_ASK_DAYS, type PhaseInfo } from "./planPhase";
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

const daysBetween = (a: string, b: string) =>
  Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000);

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
