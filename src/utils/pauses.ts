// A run's manual pauses as recorded: [pausedAt, resumedAt] epoch ms, saved on the route
// sidecar as `stats.pauses`. Analysis reads the trace on the MOVING clock (paused time
// removed), so splits and pace agree with the run's duration. docs/run-analysis.md.
import type { TrackPointOrGap } from "./geo";

export type PauseWindow = readonly [number, number];

// Only well-formed, closed, time-ordered windows; anything else in the sidecar is ignored.
export function readPauses(raw: unknown): PauseWindow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((w): w is [number, number] => Array.isArray(w) && w.length >= 2
      && Number.isFinite(w[0]) && Number.isFinite(w[1]) && w[1] > w[0])
    .map(w => [Number(w[0]), Number(w[1])] as const)
    .sort((a, b) => a[0] - b[0]);
}

// Milliseconds paused before epoch `t` (a t inside a pause counts the part already elapsed).
export function pausedMsBefore(pauses: readonly PauseWindow[], t: number): number {
  let ms = 0;
  for (const [a, b] of pauses) {
    if (a >= t) break;
    ms += Math.min(b, t) - a;
  }
  return ms;
}

// The trace on the moving clock. A pause between two fixes becomes a gap marker, so
// nothing measures pace across it (the straight-line bridge still counts as distance).
export function tracePausesRemoved(points: TrackPointOrGap[], pauses: readonly PauseWindow[]): TrackPointOrGap[] {
  if (!pauses.length) return points;
  const out: TrackPointOrGap[] = [];
  let prevT: number | null = null;
  for (const p of points) {
    if (!p) { if (out.length && out[out.length - 1] != null) out.push(null); continue; }
    const t = Number(p[2]);
    if (prevT != null && out[out.length - 1] != null && pauses.some(([a, b]) => a < t && b > prevT!)) out.push(null);
    out.push([p[0], p[1], t - pausedMsBefore(pauses, t), p[3] ?? null]);
    prevT = t;
  }
  return out;
}

export function samplesPausesRemoved<S extends { t: number }>(samples: S[], pauses: readonly PauseWindow[]): S[] {
  if (!pauses.length) return samples;
  return samples.map(s => ({ ...s, t: s.t - pausedMsBefore(pauses, s.t) }));
}

// While recording, the last window may still be open (paused now).
export type OpenPause = readonly [number, number | null];

export function closePauses(pauses: readonly OpenPause[], at: number): OpenPause[] {
  return pauses.map(([a, b]) => [a, b ?? Math.max(a, at)] as const);
}

// Recovered pauses, plus the off-clock stretch a recovery adds: the resumed run reopens
// paused, and its moving clock stopped at `offClockFrom` (unless a pause was already open).
export function recoveredPauses(raw: unknown, offClockFrom: number): OpenPause[] {
  const list: OpenPause[] = Array.isArray(raw)
    ? raw.filter((w): w is OpenPause => Array.isArray(w) && Number.isFinite(w[0]) && (w[1] == null || Number.isFinite(w[1])))
    : [];
  const last = list[list.length - 1];
  if (last && last[1] == null) return list;
  return offClockFrom > 0 ? [...list, [offClockFrom, null]] : list;
}
