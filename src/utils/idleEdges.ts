// Standing still at the start line and after the finish, with the clock
// running, is not run time. Mid-run stops (aid stations) stay counted, like an
// official race time. The tracker drops stationary fixes as jitter, so idling
// shows up as a slow leg (or silence) at either end of the trace.
import { haversineM, type StoredTrackPoint, type TrackPointOrGap } from "./geo";

const WINDOW_MS = 60_000; // sustained movement needed to call it a departure/arrival
const MOVING_MPS = 0.5;   // floor: below a steep hike, above stationary GPS drift
// Warm-up GPS drift can read 0.7-0.9 m/s, so the bar also scales with the run's
// own pace: 40% of the speed it held for three quarters of its time.
const OWN_PACE_SHARE = 0.4;

const legMps = (a: StoredTrackPoint, b: StoredTrackPoint) => haversineM(a, b) / ((b[2] - a[2]) / 1000);

// Time-weighted 25th-percentile leg speed, legs across a gap marker excluded.
function heldMps(points: TrackPointOrGap[]) {
  const legs: { v: number; dt: number }[] = [];
  let prev: StoredTrackPoint | null = null, total = 0;
  for (const p of points as (StoredTrackPoint | null)[]) {
    if (prev && p && p[2] > prev[2]) {
      const dt = p[2] - prev[2];
      legs.push({ v: legMps(prev, p), dt });
      total += dt;
    }
    prev = p;
  }
  legs.sort((a, b) => a.v - b.v);
  let acc = 0;
  for (const l of legs) if ((acc += l.dt) >= total / 4) return l.v;
  return 0;
}

// The fix the runner set off from and the one they stopped at for good, as
// indices into the trace's real fixes (gap markers dropped, so they line up with
// flattenTrack's rows). An end that is already moving at its first/last fix
// stays there, so GPS warm-up while running is never taken for standing still.
// Null when the trace never really moved.
export function idleBounds(points: TrackPointOrGap[]) {
  const pts = points.filter((p): p is StoredTrackPoint => !!p);
  const n = pts.length;
  if (n < 2) return null;
  const minMps = Math.max(MOVING_MPS, OWN_PACE_SHARE * heldMps(points));
  const moving = (a: StoredTrackPoint, b: StoredTrackPoint) => b[2] > a[2] && legMps(a, b) >= minMps;

  let d = -1;
  for (let i = 0, k = 0; i < n; i++) {
    while (k < n && pts[k][2] < pts[i][2] + WINDOW_MS) k++;
    if (k >= n) break;
    if (moving(pts[i], pts[k])) { d = i; break; }
  }
  if (d < 0) return null;
  while (d + 1 < n && !moving(pts[d], pts[d + 1])) d++;

  let a = n;
  for (let j = n - 1, k = n - 1; j > d; j--) {
    while (k >= 0 && pts[k][2] > pts[j][2] - WINDOW_MS) k--;
    if (k < 0) break;
    if (moving(pts[k], pts[j])) { a = j; break; }
  }
  if (a === n) a = n - 1;
  while (a - 1 > d && !moving(pts[a - 1], pts[a])) a--;

  return { pts, depart: d, arrive: a };
}

// Idle seconds before the runner set off and after they stopped for good.
export function idleEdgesSec(points: TrackPointOrGap[], startedAt: number | null, stoppedAt: number | null) {
  const b = startedAt && stoppedAt ? idleBounds(points) : null;
  if (!b || !startedAt || !stoppedAt) return { leadSec: 0, tailSec: 0 };
  const { pts, depart: d, arrive: a } = b;
  return {
    leadSec: d === 0 ? 0 : Math.max(0, (pts[d][2] - startedAt) / 1000),
    tailSec: a === pts.length - 1 ? 0 : Math.max(0, (stoppedAt - pts[a][2]) / 1000),
  };
}

// Moving seconds minus the idle ends. Manual pauses aren't located in time,
// so their total is credited against the trim: never trims a second twice.
export function trimmedMovingSec(movingSec: number, points: TrackPointOrGap[], startedAt: number | null, stoppedAt: number | null) {
  const { leadSec, tailSec } = idleEdgesSec(points, startedAt, stoppedAt);
  if (!startedAt || !stoppedAt) return { durationSec: movingSec, trimmedSec: 0 };
  const pausedSec = Math.max(0, (stoppedAt - startedAt) / 1000 - movingSec);
  const trimmedSec = Math.round(Math.min(Math.max(0, leadSec + tailSec - pausedSec), movingSec));
  return { durationSec: movingSec - trimmedSec, trimmedSec };
}

// The run as it saves: the trimmed clock, and the trace cut to the fixes it
// departed from and arrived at, so the drift standing there isn't distance.
export function trimIdleEnds(movingSec: number, points: TrackPointOrGap[], startedAt: number | null, stoppedAt: number | null) {
  const time = trimmedMovingSec(movingSec, points, startedAt, stoppedAt);
  const b = startedAt && stoppedAt ? idleBounds(points) : null;
  if (!b) return { ...time, points };
  let from = 0, to = points.length - 1;
  for (let i = 0, real = 0; i < points.length; i++) {
    if (!points[i]) continue;
    if (real === b.depart) from = i;
    if (real === b.arrive) to = i;
    real++;
  }
  return { ...time, points: points.slice(from, to + 1) };
}
