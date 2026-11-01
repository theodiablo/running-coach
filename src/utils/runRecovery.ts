import { LIVE_RUN_KEY } from "../constants";
import { currentUserId } from "../db";
import type { StoredTrackPoint } from "./geo";
import { recoveredPauses } from "./pauses";
import type { OpenPause } from "./pauses";

// The live-run recovery buffer (localStorage, see useRunTracker's persist) read and
// normalized in ONE place, shared by the resume offer and the app-wide "interrupted run"
// banner. A buffer is never discarded for being old (docs/live-tracking.md, recovery).

// Mirrors useRunTracker's GAP_MS: journal points that resume after a longer
// silence start a new segment rather than bridging it with a recorded line.
const RECOVERY_GAP_MS = 60000;

type HrSample = { bpm: number; t: number };
type TrackPointOrGap = StoredTrackPoint | null;

// The raw shape useRunTracker persists.
export type RecoveryBuffer = {
  points?: TrackPointOrGap[];
  hrSamples?: HrSample[];
  accSec?: number;
  pauses?: unknown;
  startAt?: number | null;
  startedAt?: number | null;
  stoppedAt?: number | null;
  state?: string;
  savedAt?: number;
  userId?: string | null;
};

// The normalized shape the resume flow consumes: moving time already includes
// the live segment that was open when the app died, and journal points (the
// native fix journal, Android) are merged past the last persisted point.
export type RecoveredRun = {
  points: TrackPointOrGap[];
  hrSamples: HrSample[];
  accSec: number;
  pauses: OpenPause[];
  startedAt: number | null;
  savedAt: number;
};

// Read the raw buffer. Returns null (removing a corrupt or empty leftover) when there is
// nothing worth offering. `key` selects the mode's buffer (LIVE_RUN_KEY or INDOOR_RUN_KEY);
// `requirePoints` says what "worth offering" means: an indoor session has no points, so it
// qualifies on recorded HR or elapsed time. Defaults read the GPS buffer.
export function readRecoveryBuffer(
  key: string = LIVE_RUN_KEY,
  { requirePoints = true }: { requirePoints?: boolean } = {},
): RecoveryBuffer | null {
  let raw: string | null = null;
  try { raw = localStorage.getItem(key); } catch { return null; }
  if (!raw) return null;
  try {
    const buf = JSON.parse(raw) as RecoveryBuffer;
    // Another account's run on a shared device: hidden, not deleted, so its
    // owner still gets it back after signing in again.
    const me = currentUserId();
    if (buf?.userId && me && buf.userId !== me) return null;
    const hasPoints = Array.isArray(buf?.points) && buf.points.some(Boolean);
    // Anything recorded at all: samples, completed moving time, or a segment
    // that was still open when the app died (a strapless session's only trace).
    const hasSomething = hasPoints || !!buf?.hrSamples?.length || !!buf?.accSec || !!buf?.startAt;
    if (requirePoints ? hasPoints : hasSomething) return buf;
  } catch { /* corrupt — fall through to cleanup */ }
  try { localStorage.removeItem(key); } catch { /* ignore */ }
  return null;
}

const lastPointT = (points: TrackPointOrGap[]): number => {
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (p) return p[2];
  }
  return 0;
};

// Normalize a raw buffer for the resume flow, optionally merging the native fix journal
// (only points newer than the last persisted one). Moving time: accSec counts only
// COMPLETED segments, so a run that died mid-segment has its open one (startAt) closed at
// the last (merged) point, else the last persist; otherwise the clock reads 0:00.
export function normalizeRecovery(buf: RecoveryBuffer, journal: StoredTrackPoint[] = []): RecoveredRun {
  const kept: TrackPointOrGap[] = Array.isArray(buf.points) ? [...buf.points] : [];
  const keptLastT = lastPointT(kept);
  const fresh = journal
    .filter(p => Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number"
      && typeof p[2] === "number" && p[2] > keptLastT)
    .sort((a, b) => a[2] - b[2]);
  if (fresh.length) {
    if (keptLastT && fresh[0][2] - keptLastT > RECOVERY_GAP_MS) kept.push(null);
    kept.push(...fresh);
  }
  const endT = Math.max(lastPointT(kept), buf.savedAt || 0);
  const openSegmentSec = buf.state === "tracking" && buf.startAt && endT > buf.startAt
    ? (endT - buf.startAt) / 1000
    : 0;
  return {
    points: kept,
    hrSamples: Array.isArray(buf.hrSamples) ? buf.hrSamples : [],
    accSec: (buf.accSec || 0) + openSegmentSec,
    pauses: recoveredPauses(buf.pauses, buf.state === "stopped" && buf.stoppedAt ? buf.stoppedAt : endT),
    startedAt: buf.startedAt || null,
    savedAt: buf.savedAt || 0,
  };
}
