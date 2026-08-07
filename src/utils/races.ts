// Race helpers — catalogue lookups, race-day auto-detection, and personal-best
// flagging. The catalogue itself is shared data fetched from Supabase (Phase 2,
// src/races.ts → listRaces); this module is the seam the rest of the app reads it through, so
// callers stay unchanged. It holds the fetched catalogue in a module-level cache
// (hydrated once at boot) and exposes the same synchronous lookups as Phase 1.
// The detection/PB helpers are pure over `participations` and stay unit-testable.

import { listRaces } from "../races";
import type { BuildPlanOptions } from "./plan";
import type { CatalogueRace, JoinedEdition, Participation, RaceCandidate, Run } from "../types";

// Module-level cache: the grouped races (each with an `editions` array) plus a
// flat edition→race join derived from them. Empty until hydrateCatalogue runs;
// a failed fetch simply leaves it empty and every lookup degrades gracefully
// (findEdition → null → callers fall back to the participation snapshot).
let _races: CatalogueRace[] = [];
let _editions: JoinedEdition[] = [];

// Flatten grouped races into the edition-joined shape lookups expect: each entry
// carries the race fields plus `raceId` and the single `edition`.
function flatten(races: CatalogueRace[]): JoinedEdition[] {
  return races.flatMap(r =>
    (r.editions || []).map((e) => ({ ...r, raceId: r.id, edition: e }))
  );
}

// Populate the cache from fetched data (src/races.ts → listRaces). Called once at
// boot and again after a user contributes, so new entries appear immediately.
export function hydrateCatalogue(races: CatalogueRace[] = []) {
  _races = races || [];
  _editions = flatten(_races);
}

// Fetch the shared catalogue and hydrate the cache. Failure-tolerant: listRaces
// already returns [] on error, so a down/slow Supabase just leaves an empty
// catalogue and the app still renders. Returns the grouped races.
export async function loadCatalogue() {
  let races: CatalogueRace[] = [];
  try { races = await listRaces(); } catch (err) { console.error("catalogue load failed", err); }
  hydrateCatalogue(races);
  return _races;
}

// Resolve an editionId to its joined race+edition object, or null if it's no
// longer in the catalogue (an orphaned participation handles its own snapshot).
export function findEdition(editionId?: string | null) {
  if (!editionId) return null;
  return _editions.find(e => e.edition.id === editionId) || null;
}

// Free-text search over joined editions for the onboarding race picker. Matches
// the race name / city / country, and by default hides editions whose date has
// already passed (a stale past date would build a degenerate plan). `today` is a
// YYYY-MM-DD string; pass it from the caller so the function stays pure.
export function searchEditions(query: string, today: string, { upcomingOnly = true }: { upcomingOnly?: boolean } = {}) {
  const q = (query || "").trim().toLowerCase();
  return _editions.filter(e => {
    if (upcomingOnly && today && e.edition.date < today) return false;
    if (!q) return true;
    return (e.name + " " + e.city + " " + e.country).toLowerCase().includes(q);
  });
}

// A human label for a participation/edition, e.g. "Behobia-San Sebastián 2026".
export function editionLabel(race?: Pick<CatalogueRace, "name"> | null, edition?: { date?: string } | null) {
  const year = (edition?.date || "").slice(0, 4);
  return [race?.name, year].filter(Boolean).join(" ");
}

// Multi-race version: match a just-logged run against ANY race on the plan.
// `candidates` is a list of {editionId, date, distanceKm} — typically every RACE
// session on the plan that carries an editionId (the main race + any secondary
// races). Returns the matched editionId, or null. Matches on the same date plus
// a distance-tolerance rule.
export function detectAnyRace(run: Run | null | undefined, candidates: RaceCandidate[] = [], tolerance = 0.18) {
  if (!run || !run.date || !run.km) return null;
  for (const c of candidates) {
    if (!c || !c.editionId || !c.date || !c.distanceKm) continue;
    if (run.date !== c.date) continue;
    const distanceKm = Number(c.distanceKm);
    if (Math.abs(run.km - distanceKm) <= distanceKm * tolerance) return c.editionId;
  }
  return null;
}

// Fastest done time per distance bucket, used to flag personal bests. Distances
// are bucketed to the nearest 0.1 km so 21.1 and 21.10 group together.
export function bestTimesByDistance(participations: Participation[] = []) {
  const best: Record<number, number> = {};
  for (const p of participations) {
    if (p.status !== "done" || !p.timeSec || !p.distanceKm) continue;
    const key = Math.round(p.distanceKm * 10) / 10;
    if (best[key] == null || p.timeSec < best[key]) best[key] = p.timeSec;
  }
  return best;
}

// Is this done participation the fastest the user has logged at its distance?
export function isPersonalBest(participation: Participation | null | undefined, participations: Participation[] = []) {
  if (participation?.status !== "done" || !participation.timeSec || !participation.distanceKm) return false;
  const best = bestTimesByDistance(participations);
  const key = Math.round(participation.distanceKm * 10) / 10;
  return best[key] === participation.timeSec;
}

// Wishlisted races the user folded into the plan, as buildPlan's `races` overlay.
// Both rebuild paths (Plan page, race toggle) go through this — a divergence
// silently changes what lands on someone's plan. Entries without a date or
// distance can't be placed on a week, so they're dropped rather than guessed.
export function secondaryRaces(
  participations: Participation[],
  targetEditionId?: string | null,
): NonNullable<BuildPlanOptions["races"]> {
  return participations
    .filter(p => p.status === "wishlist" && p.inPlan && p.editionId && p.editionId !== targetEditionId)
    .flatMap(p => p.raceDate && p.distanceKm
      ? [{ editionId: p.editionId as string, date: p.raceDate, distanceKm: p.distanceKm,
           elevation: findEdition(p.editionId)?.edition?.elevation || 0 }]
      : []);
}
