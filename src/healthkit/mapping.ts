import type { Run } from "../types";
import type { HkWorkoutRaw } from "./plugin";
import { hkImportedNote } from "../imports/dataOrigin";
import { isDuplicateRun } from "../imports/dedupe";
import { sessionLocalDate } from "../watch/mapping";

// HKWorkoutActivityType raw values we treat as runs (HealthKit constants).
export const HK_ACTIVITY_RUNNING = 37;
export const HK_ACTIVITY_WALKING = 52;
export const HK_ACTIVITY_HIKING = 24;

// Map an HKWorkoutActivityType to one of our run types, or null when it's not
// something we import (cycling, swimming, strength, …). Running → EASY (the
// user re-types TEMPO/INTERVALS/LONG on review); walking/hiking → WALK — the
// same policy as sessionRunType (src/watch/mapping.ts).
export function workoutRunType(activityType?: number): "EASY" | "WALK" | null {
  if (activityType === HK_ACTIVITY_RUNNING) return "EASY";
  if (activityType === HK_ACTIVITY_WALKING || activityType === HK_ACTIVITY_HIKING) return "WALK";
  return null;
}

// HealthKit workout ids ride the existing hcId id-space with an "hk:" prefix:
// no new dedupe id-space, no possible collision with Health Connect ids, and
// markSeen / the per-device seen list work unchanged. The same physical run
// arriving via HC on Android and HK on an iPhone still collapses through the
// startedAt time-overlap dedupe rule, not by id.
export const hkId = (uuid: string) => "hk:" + uuid;

const round2 = (n: number) => Math.round(n * 100) / 100;

// Turn a raw HealthKit workout into a partial Run ready for the save pipeline
// (goLog prefill / addRuns) — the HK mirror of sessionToRun. Elevation is
// omitted when the workout didn't record it (rather than forced to 0) so the
// field stays blank and editable. HealthKit has no per-workout zone offset, so
// sessionLocalDate falls back to the device's local zone — right for the
// overwhelmingly common case of importing on the phone that lives in the
// runner's own time zone.
export function workoutToRun(w: HkWorkoutRaw): Partial<Run> {
  const startMs = +new Date(w.startTime);
  const endMs = +new Date(w.endTime);
  const elapsedSec = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
    ? Math.round((endMs - startMs) / 1000) : 0;
  const run: Partial<Run> = {
    date: sessionLocalDate(w.startTime, null),
    type: workoutRunType(w.activityType) || "EASY",
    km: w.distanceM != null ? round2(w.distanceM / 1000) : 0,
    // Active (unpaused) time when present; fall back to elapsed so a run never
    // lands with durationSec:0 (∞ pace).
    durationSec: w.activeSec != null && w.activeSec > 0 ? Math.round(w.activeSec) : elapsedSec,
    hr: w.hrAvg != null ? Math.round(w.hrAvg) : null,
    hrMax: w.hrMax != null ? Math.round(w.hrMax) : null,
    effort: null,
    // Which app wrote the workout ("Imported from Garmin" / "… Apple Watch") —
    // several brands share the one Apple Health integration, so the run says which.
    notes: hkImportedNote(w.sourceBundleId, w.sourceName),
    source: "watch",
    hcId: hkId(w.id),
    startedAt: w.startTime,
  };
  if (w.elevationGainM != null) run.elevation = Math.round(w.elevationGainM);
  return run;
}

// Workouts that are runnable (a run/walk type) and not already logged: map
// first, then dedupe once through the ONE rule set (isDuplicateRun in
// src/imports/dedupe.ts — ids, time overlap, fuzzy day+distance fallback).
// Deliberately no workout-shaped duplicate check here — see newWatchSessions.
export function newHkWorkouts(workouts: HkWorkoutRaw[], runs: Run[], seenIds: string[]): Partial<Run>[] {
  const out: Partial<Run>[] = [];
  for (const w of workouts || []) {
    if (!w || !w.id || workoutRunType(w.activityType) == null) continue;
    const run = workoutToRun(w);
    // Dedupe against the log AND earlier candidates in this same batch.
    if (!isDuplicateRun(run, (runs || []).concat(out as Run[]), seenIds)) out.push(run);
  }
  return out;
}
