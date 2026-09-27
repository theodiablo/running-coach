// Standing still at the start line and after the finish, with the clock
// running, is not run time. Mid-run stops (aid stations) stay counted, like an
// official race time. The tracker drops stationary fixes as jitter, so idling
// shows up as a slow leg (or silence) at either end of the trace.
import { haversineM, type StoredTrackPoint, type TrackPointOrGap } from "./geo";

const WINDOW_MS = 60_000; // sustained movement needed to call it a departure/arrival
const MOVING_MPS = 0.5;   // below a steep hike, above stationary GPS drift

const moving = (a: StoredTrackPoint, b: StoredTrackPoint) =>
  b[2] > a[2] && haversineM(a, b) / ((b[2] - a[2]) / 1000) >= MOVING_MPS;

// Idle seconds before the runner set off and after they stopped for good.
// An end that is already moving at its first/last fix trims nothing, so GPS
// warm-up while running is never taken for standing still.
export function idleEdgesSec(points: TrackPointOrGap[], startedAt: number | null, stoppedAt: number | null) {
  const none = { leadSec: 0, tailSec: 0 };
  const pts = points.filter((p): p is StoredTrackPoint => !!p);
  const n = pts.length;
  if (n < 2 || !startedAt || !stoppedAt) return none;

  let d = -1;
  for (let i = 0, k = 0; i < n; i++) {
    while (k < n && pts[k][2] < pts[i][2] + WINDOW_MS) k++;
    if (k >= n) break;
    if (moving(pts[i], pts[k])) { d = i; break; }
  }
  if (d < 0) return none; // never really moved: nothing to anchor a trim on
  while (d + 1 < n && !moving(pts[d], pts[d + 1])) d++;

  let a = n;
  for (let j = n - 1, k = n - 1; j > d; j--) {
    while (k >= 0 && pts[k][2] > pts[j][2] - WINDOW_MS) k--;
    if (k < 0) break;
    if (moving(pts[k], pts[j])) { a = j; break; }
  }
  if (a === n) a = n - 1;
  while (a - 1 > d && !moving(pts[a - 1], pts[a])) a--;

  return {
    leadSec: d === 0 ? 0 : Math.max(0, (pts[d][2] - startedAt) / 1000),
    tailSec: a === n - 1 ? 0 : Math.max(0, (stoppedAt - pts[a][2]) / 1000),
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
