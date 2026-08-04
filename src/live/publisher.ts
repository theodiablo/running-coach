// Live run sharing — the recorder half.
//
// While a run is being recorded with sharing on, the whole simplified trace is
// written to the caller's single `live_runs` row so their own other sessions can
// watch it. Deleted when the run is saved or discarded.
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
import { LIVE_PUBLISHED_KEY, LIVE_RUN_KEY, RESUME_MAX_AGE_MS } from "../constants";
import { storeShareToken } from "./shareLink";
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
  // The public share token for this run, or null for same-account-only (v1
  // behaviour). Carried on every write so minting or revoking a link mid-run
  // takes effect on the next publish rather than the next run.
  shareToken?: string | null;
  // Called when the token could not be stored because someone else holds it
  // (see writeRow). The broadcast goes up without a link, so the UI must stop
  // offering one that resolves to nothing.
  onShareTokenRejected?: () => void;
};

// Per-run publishing state. Module-level rather than a hook: the decision has to
// survive every re-render of the tracker, and there is only ever one run.
let lastPublishAt = 0;
let lastStatus: LiveRunStatus | null = null;
let lastShareToken: string | null = null;
let inFlight = false;
let inFlightWrite: Promise<void> | null = null; // so teardown can wait it out
let rowCreated = false; // this run's row exists — later writes are plain UPDATEs
let blocked = false; // a policy rejection — stop hammering the API for this run

// Whether this call should actually hit the network. Pure so the cadence is
// testable without a Supabase client. A status transition (pause/resume/stop)
// always goes through: those are the updates a watcher most needs promptly, and
// they can't be re-triggered by a later GPS fix while paused.
//
// A share-token change bypasses the throttle for the same reason: minting a
// link is an explicit act that the runner is about to send to someone, and
// REVOKING one must take the run off the public link now, not up to 30s from
// now. Both are unrelated to GPS, so nothing else would push them out promptly.
export function shouldPublish(
  { now, lastAt, status, prevStatus, busy, shareToken = null, prevShareToken = null }:
  { now: number; lastAt: number; status: LiveRunStatus; prevStatus: LiveRunStatus | null; busy: boolean;
    shareToken?: string | null; prevShareToken?: string | null },
): boolean {
  if (busy) return false;
  if (status !== prevStatus) return true;
  if (shareToken !== prevShareToken) return true;
  return now - lastAt >= LIVE_PUBLISH_INTERVAL_MS;
}

// Would a publish right now actually go out? Lets the caller skip the work of
// simplifying a long trace on the ~1/s renders that will be throttled anyway.
export function canPublishNow(status: LiveRunStatus, shareToken: string | null = null): boolean {
  if (blocked) return false;
  return shouldPublish({ now: Date.now(), lastAt: lastPublishAt, status, prevStatus: lastStatus,
    busy: inFlight, shareToken, prevShareToken: lastShareToken });
}

// PostgREST surfaces an RLS refusal as 42501 (and PostgREST's own 401/403
// shapes). A user without premium can only reach this by tampering, but a lapsed
// grant mid-run reaches it honestly — either way, retrying every 30s for the
// rest of the run is pointless traffic.
const isPolicyError = (code?: string | null) => code === "42501" || code === "401" || code === "403";

export function publishLiveRun(args: PublishArgs): Promise<void> {
  if (blocked) return Promise.resolve();
  const user_id = currentUserId();
  if (!user_id) return Promise.resolve();
  const shareToken = args.shareToken ?? null;
  if (!shouldPublish({ now: Date.now(), lastAt: lastPublishAt, status: args.status, prevStatus: lastStatus,
    busy: inFlight, shareToken, prevShareToken: lastShareToken })) {
    return Promise.resolve();
  }

  inFlight = true;
  // Claim the slot up front: an upload that takes longer than the interval must
  // not let the next fix queue a second one the moment it lands.
  lastPublishAt = Date.now();
  lastStatus = args.status;
  lastShareToken = shareToken;
  const write: Promise<void> = writeRow(user_id, args).finally(() => {
    inFlight = false;
    if (inFlightWrite === write) inFlightWrite = null;
  });
  inFlightWrite = write;
  return write;
}

// INSERT to open a broadcast, UPDATE to continue one — deliberately NOT an
// upsert. Postgres checks the INSERT policy's WITH CHECK "for all rows proposed
// for insertion, regardless of whether or not they end up being inserted", so an
// `ON CONFLICT DO UPDATE` is premium-gated on the update path too: an entitlement
// lapsing mid-run would 42501, latch `blocked`, and take a run off the air —
// exactly what the premium-free UPDATE policy exists to prevent. Splitting the
// two is what makes "starting a broadcast is the privileged act, continuing one
// isn't" true rather than aspirational. Never reject: recording must not care.
async function writeRow(user_id: string, { status, points, stats, startedAt, shareToken, onShareTokenRejected }: PublishArgs): Promise<void> {
  const row = { status, points, stats };
  const share_token = shareToken ?? null;
  // Someone who was GIVEN a link can squat its token on their own row, which
  // would otherwise 23505 the original runner's next write forever (see the
  // migration). Losing the link is an acceptable outcome; losing the broadcast
  // is not — so a token conflict is retried without the token, and the caller
  // is told so the UI stops offering a link that resolves to nothing.
  const isTokenConflict = (err: { code?: string | null; message?: string } | null) =>
    err?.code === "23505" && String(err.message || "").includes("live_runs_share_token_key");
  const dropToken = () => {
    storeShareToken(null);
    lastShareToken = null;
    onShareTokenRejected?.();
  };
  try {
    if (rowCreated) {
      const update = (token: string | null) => supabase.from("live_runs")
        .update({ ...row, share_token: token }).eq("user_id", user_id).select("user_id");
      let { data, error } = await update(share_token);
      if (isTokenConflict(error)) {
        dropToken();
        ({ data, error } = await update(null));
      }
      if (error) {
        if (isPolicyError(error.code)) blocked = true;
        return; // retried on the next fix, never before the interval
      }
      // Nothing matched: the row was swept from under us (another session ended
      // the run). Re-open it on the next fix rather than publishing into a void.
      if (!data?.length) rowCreated = false;
      return;
    }
    // A fresh broadcast stamps its own start instant, so a row left by a killed
    // app gets its clock reset rather than inherited.
    const started_at = new Date(startedAt || Date.now()).toISOString();
    const insert = (token: string | null) =>
      supabase.from("live_runs").insert({ user_id, ...row, started_at, share_token: token });
    let { error } = await insert(share_token);
    // Our OWN leftover row from a killed app is in the way — this run replaces
    // it wholesale. Checked second so a token conflict isn't "fixed" by
    // deleting a perfectly good row of ours.
    if (error?.code === "23505" && !isTokenConflict(error)) {
      await supabase.from("live_runs").delete().eq("user_id", user_id);
      ({ error } = await insert(share_token));
    }
    if (isTokenConflict(error)) {
      dropToken();
      ({ error } = await insert(null));
    }
    if (error) {
      if (isPolicyError(error.code)) blocked = true;
      return;
    }
    rowCreated = true;
    markPublished(started_at);
  } catch {
    /* offline — the next accepted fix republishes the full trace */
  }
}

// Take the run off the air. Best-effort by design: this is called from save and
// discard, neither of which may fail because of it. If the delete doesn't land,
// the watcher falls back to its staleness display and the marker keeps the boot
// sweep on the hook for it.
export async function endLiveRun(): Promise<void> {
  const user_id = currentUserId();
  // Let a write already on the wire land FIRST. A delete that overtakes it is
  // undone the moment it completes — putting the whole trace back on the air
  // after the run was saved or discarded, which is the one thing the privacy
  // page promises can't happen. (writeRow never rejects; this can't throw.)
  await inFlightWrite;
  resetLivePublisher();
  // The link dies with the broadcast, whether or not the delete below lands: a
  // token that outlived its run would be re-published by the NEXT one, silently
  // reopening a link the runner shared once, for a run they never shared. The
  // row is what a viewer reads, and it is on its way out either way.
  storeShareToken(null);
  if (!user_id) return;
  try {
    const { error } = await supabase.from("live_runs").delete().eq("user_id", user_id);
    if (!error) clearPublishedMarker();
  } catch {
    /* best effort */
  }
}

// Take down a broadcast THIS DEVICE left on the air, and only that one.
//
// The row is per-account, so an unscoped delete is indistinguishable from
// sabotage: a watching session is by definition another session of the same
// account, and would delete the very run it opened the app to follow. Scoped
// twice over — only a device holding the marker sweeps at all, and only when the
// row still carries the `started_at` that device published.
export async function sweepOwnLiveRun(): Promise<void> {
  const mine = readPublishedMarker();
  // A sweep resolves a broadcast this device left behind, so its link is spent
  // too. Done up front and unconditionally: with no marker there is nothing on
  // the air, and a token still sitting here is one minted for a run that never
  // started — exactly the stale link the NEXT run must not inherit.
  storeShareToken(null);
  if (!mine) return;
  const user_id = currentUserId();
  if (!user_id) return;
  try {
    const { data, error } = await supabase.from("live_runs")
      .select("started_at").eq("user_id", user_id).maybeSingle();
    if (error) return; // offline — retried next boot, marker intact
    // Already gone, or replaced by a newer broadcast from another device. Either
    // way this device's row is off the air and the marker has done its job.
    if (!data || Date.parse(data.started_at) !== Date.parse(mine)) { clearPublishedMarker(); return; }
    const { error: delError } = await supabase.from("live_runs").delete().eq("user_id", user_id);
    if (!delError) clearPublishedMarker();
  } catch {
    /* best effort — retried next boot */
  }
}

// Boot sweep for a row left behind by an app that was killed mid-run. Called
// once on boot, alongside flushPendingRoutes. Skipped while a recoverable buffer
// exists: that run can still be resumed, and a watcher may be following it right
// now. Discarding the recovery instead is what takes it down (LiveRunTracker).
export async function clearStaleLiveRun(): Promise<void> {
  if (hasRecoverableRun()) return;
  await sweepOwnLiveRun();
}

function hasRecoverableRun(): boolean {
  try {
    const raw = localStorage.getItem(LIVE_RUN_KEY);
    if (!raw) return false;
    const buf = JSON.parse(raw) as { points?: unknown[]; savedAt?: number };
    if (!Array.isArray(buf?.points) || buf.points.length === 0) return false;
    // The same cutoff useRunTracker applies before it offers the resume. Without
    // it an expired buffer — one that will never be offered, and is dropped on
    // the tracker's next mount — would block the sweep forever.
    return Date.now() - (buf.savedAt || 0) < RESUME_MAX_AGE_MS;
  } catch {
    return false;
  }
}

const markPublished = (startedAtIso: string) => {
  try { localStorage.setItem(LIVE_PUBLISHED_KEY, startedAtIso); } catch { /* quota — non-fatal */ }
};
const clearPublishedMarker = () => {
  try { localStorage.removeItem(LIVE_PUBLISHED_KEY); } catch { /* ignore */ }
};
const readPublishedMarker = (): string | null => {
  try { return localStorage.getItem(LIVE_PUBLISHED_KEY); } catch { return null; }
};

// Forget per-run state so the next run publishes immediately and re-stamps its
// own started_at. Deliberately does NOT clear the published marker: that is
// cleared only by a confirmed delete, so a teardown that never landed still gets
// swept later.
export function resetLivePublisher(): void {
  lastPublishAt = 0;
  lastStatus = null;
  // Only the module's memory of what was last written. The STORED token is
  // deliberately untouched: a recovered run has to republish under the link
  // already sent out, and endLiveRun is what actually spends it.
  lastShareToken = null;
  inFlight = false;
  inFlightWrite = null;
  rowCreated = false;
  blocked = false;
}
