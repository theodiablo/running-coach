// One-time, bounded backfill of `bestEfforts` onto GPS runs recorded before the
// feature existed.
//
// Why it has to exist: the post-run reward ranks a run against the log, and a
// log with no measured history would greet a long-time user's next run with
// "first 5K on record" — or worse, call it their fastest when an older, faster
// 5K sits unmeasured inside a 10 km trace. Runs without a trace need no backfill
// (effortsFor derives their whole-run estimate on the fly); only GPS runs do.
//
// Cost control, deliberately conservative:
//   - newest RUN_LIMIT runs only, so a long history can't turn a cold start into
//     a multi-megabyte download. Older runs keep their whole-run estimate, which
//     means a genuine PB buried in an ancient trace can still be missed.
//   - points only (`getRoute(id, false)`) — the stats sidecar can hold a whole
//     ~1Hz HR stream, which this doesn't need.
//   - sequential, off the critical path, and entirely silent.
//   - the done-marker is per-device localStorage, and is only set once a pass
//     completes with no fetch failures, so an offline cold start retries later.
//
// The marker is keyed by USER id. It lives in localStorage, which survives sign
// out, so a device-global key would tell the second account on a shared phone
// that its own pre-feature runs had already been measured — producing exactly
// the false "first 5K on record" this exists to prevent.

import { getRoute } from "./routes";
import { bestEffortsFromTrack, type BestEfforts } from "./utils/bestEfforts";
import type { Run } from "./types";

const MARKER_PREFIX = "rc_best_efforts_backfill";
const MARKER_VERSION = "1";
export const RUN_LIMIT = 40;

export type EffortPatch = { id: string; bestEfforts: BestEfforts };

const markerKey = (userId: string) => `${MARKER_PREFIX}:${userId}`;

// A blocked/absent localStorage reads as "already done": without somewhere to
// record completion this would re-download traces on every single boot. So does
// a missing user id — a marker written before the session is known would be
// unreachable once it is, leaving the pass to repeat forever.
export function backfillDone(userId?: string | null): boolean {
  if (!userId) return true;
  try { return localStorage.getItem(markerKey(userId)) === MARKER_VERSION; }
  catch { return true; }
}

export function runsNeedingBackfill(runs: Run[]): Run[] {
  // `runs` is kept newest-first, so the cap keeps the recent history that PB
  // comparisons actually lean on.
  return runs.filter(r => r.id && r.routeId && !r.bestEfforts).slice(0, RUN_LIMIT);
}

// Measure each candidate's stored trace and hand the patches back for the caller
// to merge — this module never writes state itself, so the single blob write
// stays with the owner of `runs`.
export async function backfillBestEfforts(runs: Run[], userId?: string | null): Promise<EffortPatch[]> {
  const patches: EffortPatch[] = [];
  let failed = 0;
  for (const r of runsNeedingBackfill(runs)) {
    try {
      const trace = await getRoute(r.routeId!, false);
      // A route row that's gone (or came back empty) is settled, not a failure:
      // retrying it on the next boot would never produce anything different.
      patches.push({ id: r.id!, bestEfforts: trace?.points?.length ? bestEffortsFromTrack(trace.points) : {} });
    } catch { failed++; }
  }
  if (!failed && userId) {
    try { localStorage.setItem(markerKey(userId), MARKER_VERSION); } catch { /* quota */ }
  }
  return patches;
}
