import type { Participation, Plan, RacesState, Run, SettingsState } from "../types";
import { detectAnyRace, editionLabel, findEdition } from "./races";
import { mainRace } from "./planPhase";
import { inRaceDayMode, wishlistRaceCandidates } from "./raceDay";

// Race-day auto-detect, pure over the plan, settings and races: which race did
// a just-saved run turn out to be, and what does that settle. docs/races.md.
export type RaceCand = {
  key: string;
  // Null for a hand-entered race: there is a session to tick but no participation.
  editionId: string | null;
  date: string;
  distanceKm: number;
  sess?: { wNum: number; sId: string; done: boolean };
};

export type RaceCompletion = {
  nextRaces: RacesState;
  undoParts: Participation[];
  label: string;
  // The distance of the race that was run.
  km: number;
  // Catalogue only: hand-entered races settle quietly, no confetti.
  isMain: boolean;
  raceDay: boolean;
  // The RACE session to tick with this run; null when it is already settled.
  link: { wNum: number; sId: string; runId: string } | null;
};

// Every race the plan holds (main first, then secondary ones), the settings
// target for plans built before RACE sessions carried an edition, and, with no
// plan at all, the wishlist.
export function raceCandidates(plan: Plan | null | undefined, settings: SettingsState, parts: Participation[], raceDay: boolean): RaceCand[] {
  const cands: RaceCand[] = [];
  const seen = new Set<string>();
  const main = mainRace(plan, settings);
  if (main) {
    cands.push({ key: "main", editionId: main.editionId, date: main.date, distanceKm: main.km,
      sess: { wNum: main.wNum, sId: main.sId, done: !!main.session.done } });
    if (main.editionId) seen.add(main.editionId);
  }
  for (const w of plan?.weeks || []) for (const s of w.sessions || []) {
    if (s.type !== "RACE" || !s.editionId || seen.has(s.editionId) || (main && main.sId === s.id)) continue;
    seen.add(s.editionId);
    // Carried history is not a race to tick, only one to recognise.
    cands.push({ key: s.editionId, editionId: s.editionId, date: s.date, distanceKm: Number(s.km),
      ...(s.id.startsWith("past-") ? {} : { sess: { wNum: w.weekNumber, sId: s.id, done: !!s.done } }) });
  }
  if (settings.targetEditionId && settings.raceDate && settings.distanceKm && !seen.has(settings.targetEditionId)) {
    seen.add(settings.targetEditionId);
    cands.push({ key: settings.targetEditionId, editionId: settings.targetEditionId, date: settings.raceDate, distanceKm: Number(settings.distanceKm) });
  }
  if (raceDay) cands.push(...wishlistRaceCandidates(parts).filter(c => !seen.has(c.editionId))
    .map(c => ({ ...c, key: c.editionId })));
  return cands;
}

export function detectRaceCompletion(
  { added, plan, settings, races, yourRaceLabel }:
  { added: Run[]; plan: Plan | null | undefined; settings: SettingsState; races: RacesState; yourRaceLabel: string },
): RaceCompletion | null {
  const parts = races.participations || [];
  const raceDay = inRaceDayMode(settings, plan ?? null);
  const cands = raceCandidates(plan, settings, parts, raceDay);
  if (!cands.length) return null;
  let match: Run | null = null, cand: RaceCand | null = null;
  for (const r of added) {
    const c = detectAnyRace(r, cands);
    if (c) { match = r; cand = c; break; }
  }
  if (!match || !cand) return null;
  const edId = cand.editionId;
  const prev = edId ? parts.find(p => p.editionId === edId) || null : null;
  const needsPart = !!edId && prev?.status !== "done";
  const needsSess = !!cand.sess && !cand.sess.done;
  if (!needsPart && !needsSess) return null; // already settled: don't double-mark
  const joined = edId ? findEdition(edId) : null;
  const label = prev?.label || (joined ? editionLabel({ name: String(joined.name) }, joined.edition) : yourRaceLabel);
  let nextRaces = races;
  if (needsPart && edId) {
    const ed = joined?.edition || { id: edId, date: match.date, distanceKm: match.km };
    const snapshot = { editionId: edId, raceId: joined?.raceId, label, raceDate: ed.date, distanceKm: ed.distanceKm };
    const done = { ...(prev || snapshot), status: "done", timeSec: match.durationSec, runId: match.id, source: "auto", notes: prev?.notes || "" };
    nextRaces = { ...races, participations: prev ? parts.map(p => p.editionId === edId ? done : p) : [...parts, done] };
  }
  return {
    nextRaces, undoParts: parts, label, raceDay, km: Number(cand.distanceKm) || match.km,
    isMain: needsPart && (raceDay || edId === settings.targetEditionId),
    link: needsSess && cand.sess && match.id ? { wNum: cand.sess.wNum, sId: cand.sess.sId, runId: match.id } : null,
  };
}
