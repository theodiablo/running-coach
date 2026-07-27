// Live run sharing — the recorder half.
//
// While a run is being recorded with sharing on, the whole simplified trace is
// upserted into the caller's single `live_runs` row so their own other sessions
// can watch it. Deleted when the run is saved or discarded.
//
// Two constraints shape everything here:
//
// 1. NOTHING may be driven by a timer. A backgrounded WebView throttles JS
//    timers to a crawl, which is precisely when a run is being recorded with
//    the screen off. Every publish is therefore triggered by an accepted GPS
//    fix (the same render that already drives the lock-screen notification),
//    and this module only decides whether enough time has passed. A stationary
//    runner emits no fixes and so publishes nothing — the WATCHER owns
//    staleness, and says "signal lost" on its own.
//
// 2. NOTHING here may break recording. Every call is fire-and-forget and
//    swallows its error; a failed publish simply retries on the next fix, and
//    because each upsert carries the full trace, a gap heals itself rather than
//    leaving a hole.

import { supabase } from "../supabase";
import { currentUserId } from "../db";
import { LIVE_RUN_KEY } from "../constants";
import type { TrackPointOrGap } from "../utils/geo";

// Matches the watcher's poll cadence. Polling faster than the phone writes only
// buys reads that cannot contain anything new; publishing faster than this
// costs battery and rows for a position that has barely moved.
export const LIVE_PUBLISH_INTERVAL_MS = 30000;

export type LiveRunStatus = "live" | "paused" | "ended";
export type LiveRunStats = { km: number; durationSec: number; avgPace: number; curPace: number };
export type LiveRunRow = {
  user_id: string;
  status: LiveRunStatus;
  started_at: string;
  updated_at: string;
  points: TrackPointOrGap[];
  stats: Partial<LiveRunStats>;
};

type PublishArgs = {
  status: LiveRunStatus;
  points: TrackPointOrGap[];
  stats: LiveRunStats;
  startedAt?: number | null;
};

// Per-run publishing state. Module-level rather than a hook: the decision has to
// survive every re-render of the tracker, and there is only ever one run.
let lastPublishAt = 0;
let lastStatus: LiveRunStatus | null = null;
let inFlight = false;
let blocked = false; // a policy rejection — stop hammering the API for this run

// Whether this call should actually hit the network. Pure so the cadence is
// testable without a Supabase client. A status transition (pause/resume/stop)
// always goes through: those are the updates a watcher most needs promptly, and
// they can't be re-triggered by a later GPS fix while paused.
export function shouldPublish(
  { now, lastAt, status, prevStatus, busy }:
  { now: number; lastAt: number; status: LiveRunStatus; prevStatus: LiveRunStatus | null; busy: boolean },
): boolean {
  if (busy) return false;
  if (status !== prevStatus) return true;
  return now - lastAt >= LIVE_PUBLISH_INTERVAL_MS;
}

// Would a publish right now actually go out? Lets the caller skip the work of
// simplifying a long trace on the ~1/s renders that will be throttled anyway.
export function canPublishNow(status: LiveRunStatus): boolean {
  if (blocked) return false;
  return shouldPublish({ now: Date.now(), lastAt: lastPublishAt, status, prevStatus: lastStatus, busy: inFlight });
}

// PostgREST surfaces an RLS refusal as 42501 (and PostgREST's own 401/403
// shapes). A user without premium can only reach this by tampering, but a lapsed
// grant mid-run reaches it honestly — either way, retrying every 30s for the
// rest of the run is pointless traffic.
const isPolicyError = (code?: string | null) => code === "42501" || code === "401" || code === "403";

export async function publishLiveRun({ status, points, stats, startedAt }: PublishArgs): Promise<void> {
  if (blocked) return;
  const user_id = currentUserId();
  if (!user_id) return;
  if (!shouldPublish({ now: Date.now(), lastAt: lastPublishAt, status, prevStatus: lastStatus, busy: inFlight })) return;

  inFlight = true;
  // Claim the slot up front: an upload that takes longer than the interval must
  // not let the next fix queue a second one the moment it lands.
  lastPublishAt = Date.now();
  const firstOfRun = lastStatus === null;
  lastStatus = status;
  try {
    const { error } = await supabase.from("live_runs").upsert({
      user_id,
      status,
      points,
      stats,
      // Only on the first write of a run: on later upserts the column is left
      // out so the original start instant survives, and a stale row left by a
      // killed app gets its clock reset rather than inherited.
      ...(firstOfRun ? { started_at: new Date(startedAt || Date.now()).toISOString() } : {}),
    }, { onConflict: "user_id" });
    if (error) {
      if (isPolicyError(error.code)) blocked = true;
      // Retry on the next fix — but not before the interval, so a persistent
      // failure can't turn into a request per GPS fix.
    }
  } catch {
    /* offline — the next accepted fix republishes the full trace */
  } finally {
    inFlight = false;
  }
}

// Take the run off the air. Best-effort by design: this is called from save and
// discard, neither of which may fail because of it. If the delete doesn't land,
// the watcher falls back to its staleness display and clearStaleLiveRun sweeps
// the row on the next app start.
export async function endLiveRun(): Promise<void> {
  const user_id = currentUserId();
  resetLivePublisher();
  if (!user_id) return;
  try {
    await supabase.from("live_runs").delete().eq("user_id", user_id);
  } catch {
    /* best effort */
  }
}

// Sweep a row left behind by an app that was killed mid-run. Called once on
// boot, alongside flushPendingRoutes. A recoverable buffer means the run may
// still be resumed, so the row stays: deleting it would take a resumable run off
// the air for a watcher who is still looking at it.
export async function clearStaleLiveRun(): Promise<void> {
  if (hasRecoverableRun()) return;
  const user_id = currentUserId();
  if (!user_id) return;
  try {
    await supabase.from("live_runs").delete().eq("user_id", user_id);
  } catch {
    /* best effort — retried next boot */
  }
}

function hasRecoverableRun(): boolean {
  try {
    const raw = localStorage.getItem(LIVE_RUN_KEY);
    if (!raw) return false;
    const buf = JSON.parse(raw) as { points?: unknown[] };
    return Array.isArray(buf?.points) && buf.points.length > 0;
  } catch {
    return false;
  }
}

// Forget per-run state so the next run publishes immediately and re-stamps its
// own started_at.
export function resetLivePublisher(): void {
  lastPublishAt = 0;
  lastStatus = null;
  inFlight = false;
  blocked = false;
}
