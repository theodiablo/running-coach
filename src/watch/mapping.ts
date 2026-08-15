import type { Run } from "../types";
import type { WatchSessionRaw } from "./plugin";
import { p2, ymd } from "../utils/format";
import { importedNote } from "../imports/dataOrigin";
import { isDuplicateRun } from "../imports/dedupe";

// Health Connect ExerciseSessionRecord exercise-type ids we treat as runs.
// (androidx.health.connect.client.records.ExerciseSessionRecord constants.)
export const EXERCISE_TYPE_RUNNING = 56;
export const EXERCISE_TYPE_RUNNING_TREADMILL = 57;
export const EXERCISE_TYPE_WALKING = 79;
export const EXERCISE_TYPE_HIKING = 37;

// Map a Health Connect exercise type to one of our run types, or null when it's
// not something we import (cycling, swimming, strength, …). Running/treadmill →
// EASY (the user re-types TEMPO/INTERVALS/LONG on review); walking/hiking → WALK.
export function sessionRunType(exerciseType?: number): "EASY" | "WALK" | null {
  if (exerciseType === EXERCISE_TYPE_RUNNING || exerciseType === EXERCISE_TYPE_RUNNING_TREADMILL) return "EASY";
  if (exerciseType === EXERCISE_TYPE_WALKING || exerciseType === EXERCISE_TYPE_HIKING) return "WALK";
  return null;
}

// UTC counterpart of format.ts's local-time `ymd`.
function utcYmd(ms: number): string {
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + p2(d.getUTCMonth() + 1) + "-" + p2(d.getUTCDate());
}

// The run's calendar date in the runner's own time zone. Health Connect returns
// start instants in UTC ("…Z"), so a run late at night in UTC+10 would land on
// the wrong day without the session's zone offset. When the offset is unknown,
// fall back to the device's local zone.
export function sessionLocalDate(startTime: string, zoneOffsetSec?: number | null): string {
  const ms = +new Date(startTime);
  if (!Number.isFinite(ms)) return "";
  if (zoneOffsetSec != null && Number.isFinite(zoneOffsetSec)) return utcYmd(ms + zoneOffsetSec * 1000);
  return ymd(new Date(ms));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Turn a raw Health Connect session into a partial Run ready for the save
// pipeline (goLog prefill / addRuns). Elevation is omitted when the watch didn't
// record it (rather than forced to 0) so the field stays blank and editable.
export function sessionToRun(s: WatchSessionRaw): Partial<Run> {
  const startMs = +new Date(s.startTime);
  const endMs = +new Date(s.endTime);
  const elapsedSec = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
    ? Math.round((endMs - startMs) / 1000) : 0;
  const run: Partial<Run> = {
    date: sessionLocalDate(s.startTime, s.startZoneOffsetSec),
    type: sessionRunType(s.exerciseType) || "EASY",
    km: s.distanceM != null ? round2(s.distanceM / 1000) : 0,
    // Active (unpaused) time when the aggregate has it; a 0/absent aggregate
    // falls back to elapsed so a run never lands with durationSec:0 (∞ pace).
    durationSec: s.activeSec != null && s.activeSec > 0 ? Math.round(s.activeSec) : elapsedSec,
    hr: s.hrAvg != null ? Math.round(s.hrAvg) : null,
    hrMax: s.hrMax != null ? Math.round(s.hrMax) : null,
    effort: null,
    // Which app wrote the session ("Imported from Garmin" / "… Zepp") — several
    // brands share the one Health Connect integration, so the run says which.
    notes: importedNote(s.dataOrigin),
    source: "watch",
    hcId: s.id,
    startedAt: s.startTime,
  };
  if (s.elevationGainM != null) run.elevation = Math.round(s.elevationGainM);
  return run;
}

// Why a raw session did (or didn't) become an imported run. This is the single
// vocabulary the real import AND the diagnostics sync-log share, so the log can
// never disagree with what actually imported.
export type SessionOutcome =
  | "imported"      // became a new run
  | "not-run-type"  // an exercise session, but not running/walking (cycling, swim…)
  | "too-short"     // a run under the minimum-distance filter
  | "already-seen"  // this device already imported/dismissed this session id
  | "duplicate"     // matches a run already in the log (id/time/fuzzy)
  | "invalid";      // unusable (missing id)

export type ClassifiedSession = { raw: WatchSessionRaw; run: Partial<Run> | null; outcome: SessionOutcome };

// Classify EVERY raw Health Connect session into an import outcome, keeping the
// ONE dedupe rule set (isDuplicateRun in src/imports/dedupe.ts — ids, time
// overlap, fuzzy day+distance fallback). This is the single source both the real
// import (newWatchSessions) and the sync-log read from — there is deliberately no
// second session-shaped duplicate check (two parallel implementations of the same
// rules drifted on edge cases before). `minKm` mirrors the scan's short-run
// filter; pass 0 to disable it. `already-seen` is reported separately from
// `duplicate` for the diagnostics log, but both are excluded from the import.
export function classifyWatchSessions(
  sessions: WatchSessionRaw[],
  runs: Run[],
  seenIds: string[],
  minKm = 0,
): ClassifiedSession[] {
  const out: ClassifiedSession[] = [];
  const accepted: Partial<Run>[] = [];
  for (const s of sessions || []) {
    if (!s || !s.id) { if (s) out.push({ raw: s, run: null, outcome: "invalid" }); continue; }
    if (sessionRunType(s.exerciseType) == null) { out.push({ raw: s, run: null, outcome: "not-run-type" }); continue; }
    const run = sessionToRun(s);
    if ((Number(run.km) || 0) < minKm) { out.push({ raw: s, run, outcome: "too-short" }); continue; }
    if (seenIds.includes(s.id)) { out.push({ raw: s, run, outcome: "already-seen" }); continue; }
    // Dedupe against the log AND earlier accepted candidates in this same batch.
    // seenIds handled above, so pass [] here to keep the two reasons distinct.
    if (isDuplicateRun(run, (runs || []).concat(accepted as Run[]), [])) { out.push({ raw: s, run, outcome: "duplicate" }); continue; }
    accepted.push(run);
    out.push({ raw: s, run, outcome: "imported" });
  }
  return out;
}

// Sessions that are runnable and not already logged, as plain runs. Thin wrapper
// over classifyWatchSessions so there is exactly one import code path.
export function newWatchSessions(sessions: WatchSessionRaw[], runs: Run[], seenIds: string[]): Partial<Run>[] {
  return classifyWatchSessions(sessions, runs, seenIds, 0)
    .filter(c => c.outcome === "imported")
    .map(c => c.run as Partial<Run>);
}
