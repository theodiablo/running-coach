// Race helpers: catalogue lookups, race-day auto-detection, PB flagging. The catalogue is searched
// server-side (src/races.ts searchRaces); this module caches only the races the app must resolve
// synchronously: the account's own (loaded at boot) plus any it has seen in a search result.
// Detection/PB helpers are pure over `participations`.

import { listKnownRaces } from "../races";
import type { BuildPlanOptions } from "./plan";
import type { CatalogueRace, JoinedEdition, Participation, RaceCandidate, Run } from "../types";

// Empty until loaded; a failed fetch leaves it so, and findEdition → null makes callers fall back
// to the participation snapshot.
let _races: CatalogueRace[] = [];
let _editions: JoinedEdition[] = [];

// Each race's editions as the edition-joined shape lookups expect (race fields + raceId + edition).
export function flattenRaces(races: CatalogueRace[]): JoinedEdition[] {
  return races.flatMap(r =>
    (r.editions || []).map((e) => ({ ...r, raceId: r.id, edition: e }))
  );
}

// Replace the cache (boot load, tests).
export function hydrateCatalogue(races: CatalogueRace[] = []) {
  _races = races || [];
  _editions = flattenRaces(_races);
}

// Merge races into the cache, newest copy winning, so an edition picked from a search resolves.
export function rememberRaces(races: CatalogueRace[] = []) {
  if (!races.length) return;
  const byId = new Map(_races.map(r => [r.id, r]));
  for (const r of races) {
    const race = { ...r };
    delete race.distKm;
    byId.set(r.id, race);
  }
  hydrateCatalogue([...byId.values()]);
}

export function knownRaces() { return _races; }

// Fetch the races this account references (its participations, target, plan races and own
// contributions) into the cache. Failure-tolerant; returns the cached races.
export async function loadCatalogue(scope: { editionIds?: string[]; userId?: string | null } = {}) {
  let races: CatalogueRace[] = [];
  try { races = await listKnownRaces(scope); } catch (err) { console.error("catalogue load failed", err); }
  rememberRaces(races);
  return _races;
}

// Resolve an editionId to its joined race+edition object, or null if it's no
// longer in the catalogue (an orphaned participation handles its own snapshot).
export function findEdition(editionId?: string | null) {
  if (!editionId) return null;
  return _editions.find(e => e.edition.id === editionId) || null;
}

// A human label for a participation/edition, e.g. "Behobia-San Sebastián 2026".
export function editionLabel(race?: Pick<CatalogueRace, "name"> | null, edition?: { date?: string } | null) {
  const year = (edition?.date || "").slice(0, 4);
  return [race?.name, year].filter(Boolean).join(" ");
}

// Multi-race: match a just-logged run against ANY race on the plan. `candidates` are the main and
// secondary races, with or without a catalogue edition. Returns the match or null (same date plus a
// distance tolerance).
export function detectAnyRace<C extends RaceCandidate>(run: Run | null | undefined, candidates: C[] = [], tolerance = 0.18): C | null {
  if (!run || !run.date || !run.km) return null;
  for (const c of candidates) {
    if (!c || !c.date || !c.distanceKm) continue;
    if (run.date !== c.date) continue;
    const distanceKm = Number(c.distanceKm);
    if (Math.abs(run.km - distanceKm) <= distanceKm * tolerance) return c;
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

export type RaceDateChange = {
  editionId: string;
  label: string;
  oldDate: string;
  newDate: string;
  isTarget: boolean;
};

// Races whose catalogue date no longer matches the date planned around (a participation snapshots its
// date; the training target uses `settings.raceDate`). Pure over the catalogue, so a failed load reports
// nothing. `acks` are dates the user chose to ignore; a race fully passed on both dates is left alone.
export function raceDateChanges(
  participations: Participation[] = [],
  catalogue: CatalogueRace[] = [],
  target: { editionId?: string | null; raceDate?: string | null } = {},
  acks: Record<string, string> = {},
  today: string,
): RaceDateChange[] {
  const byId = new Map<string, { name: string; date: string }>();
  for (const r of catalogue) for (const e of r.editions || []) byId.set(e.id, { name: r.name, date: e.date });
  const planned = new Map<string, { date: string; label?: string }>();
  for (const p of participations) {
    if (p.status === "wishlist" && p.editionId && p.raceDate) planned.set(p.editionId, { date: p.raceDate, label: p.label });
  }
  const done = new Set(participations.filter(p => p.status === "done").map(p => p.editionId));
  if (target.editionId && target.raceDate && !done.has(target.editionId)) {
    planned.set(target.editionId, { ...planned.get(target.editionId), date: target.raceDate });
  }
  const out: RaceDateChange[] = [];
  for (const [editionId, p] of planned) {
    const ed = byId.get(editionId);
    if (!ed || ed.date === p.date || acks[editionId] === ed.date) continue;
    if (ed.date < today && p.date < today) continue;
    out.push({
      editionId, oldDate: p.date, newDate: ed.date, isTarget: editionId === target.editionId,
      label: p.label || editionLabel({ name: ed.name }, { date: ed.date }),
    });
  }
  return out.sort((a, b) => a.newDate.localeCompare(b.newDate));
}
