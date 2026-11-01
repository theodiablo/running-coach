import type { TrackPointOrGap } from "../utils/geo";

// Normalizers for the raw route + HR series a native health-store bridge returns per finished
// workout (HealthKit HKWorkoutRoute / HR; Health Connect HeartRateRecord). Pure and unit-tested
// so the native side stays a thin "return everything raw" shim. Shared by
// src/healthkit/import.ts and src/watch/import.ts so the two can't drift.

export type HrSample = { bpm: number; t: number };

// A raw route point is [lat, lng, tEpochMs, alt|null]; anything malformed is
// dropped rather than trusted. altitude is optional (kept null when the source
// point had no valid vertical fix) — a null ALTITUDE is a valid point with
// unknown elevation, NOT the whole-null gap marker the tracker uses.
export function normalizeRoutePoints(route?: unknown): TrackPointOrGap[] {
  if (!Array.isArray(route)) return [];
  const pts: TrackPointOrGap[] = [];
  for (const p of route) {
    if (!Array.isArray(p) || p.length < 3) continue;
    const lat = p[0], lng = p[1], t = p[2], alt = p[3];
    if (typeof lat !== "number" || !Number.isFinite(lat)) continue;
    if (typeof lng !== "number" || !Number.isFinite(lng)) continue;
    if (typeof t !== "number" || !Number.isFinite(t)) continue;
    pts.push([lat, lng, t, typeof alt === "number" && Number.isFinite(alt) ? alt : null]);
  }
  return pts;
}

// Raw HR samples → {bpm, t} in epoch ms, dropping zeros/NaNs. Matches the shape
// LiveRunTracker persists as `stats.hrSamples` so RunDetailModal renders an
// imported HR stream exactly like a BLE-strap one.
export function normalizeHrSamples(samples?: unknown): HrSample[] {
  if (!Array.isArray(samples)) return [];
  const out: HrSample[] = [];
  for (const s of samples) {
    if (!s || typeof s !== "object") continue;
    const bpm = Math.round(Number((s as { bpm?: unknown }).bpm) || 0);
    const t = Number((s as { t?: unknown }).t);
    if (bpm > 0 && Number.isFinite(t)) out.push({ bpm, t });
  }
  return out;
}
