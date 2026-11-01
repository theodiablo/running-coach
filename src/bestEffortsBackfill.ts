// One-time bounded backfill of `bestEfforts` onto pre-feature GPS runs (newest RUN_LIMIT only, points-only fetches,
// sequential, silent) so PB ranking has history. Detail: docs/best-efforts.md.
// The done-marker is keyed by USER id, not device: localStorage survives sign-out, and a device-global key would
// mark a second account's runs as already measured.

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
