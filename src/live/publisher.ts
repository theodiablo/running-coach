// Live run sharing — the recorder half. Publishes the whole simplified trace to
// the caller's single `live_runs` row while a run is recording; deleted on save
// or discard.
//
// Two constraints shape everything here. NOTHING may be driven by a timer: a
// backgrounded WebView throttles them to a crawl, which is exactly when a run is
// being recorded, so every publish rides an accepted GPS fix and this module
// only decides whether enough time has passed — a stationary runner publishes
// nothing and the WATCHER owns staleness. And NOTHING here may break recording:
// every call is fire-and-forget and swallows its error, and because each upsert
// carries the full trace, a gap heals itself. Detail: docs/live-sharing.md.

import { supabase } from "../supabase";
import { currentUserId } from "../db";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config";
import { LIVE_PUBLISHED_KEY, LIVE_RUN_KEY, RESUME_MAX_AGE_MS } from "../constants";
import { storeShareToken } from "./shareLink";
import { mintPublishToken, readPublishToken, storePublishToken } from "./publishToken";
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
  // The WRITE capability for the native screen-off uploader (v3). Carried on
  // every write like the share token; null only for a run started before the
  // token existed. Scopes the continuing UPDATE to the row THIS device opened.
  publishToken?: string | null;
  // Called when the token could not be stored because someone else holds it
  // (see writeRow). The broadcast goes up without a link, so the UI must stop
  // offering one that resolves to nothing.
  onShareTokenRejected?: () => void;
  // Called when the publish token had to be re-minted (a 23505 on ITS index —
  // astronomically unlikely, but a distinct index means a distinct branch).
  // The caller must re-seed the native uploader with the replacement.
  onPublishTokenChanged?: (token: string) => void;
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
// shapes). Live sharing has no premium gate, so a real user can only reach this
// by tampering — but retrying every 30s for the rest of the run over a refusal
// that will never clear is still pointless traffic.
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
// upsert. The update is scoped to OUR row via `publish_token` (see below), which
// `ON CONFLICT DO UPDATE` can't express — an upsert would silently stamp our
// tokens over another device's live run instead of re-opening our own via
// insert. Splitting the two also keeps the two paths' error handling distinct:
// a swept row surfaces as "update matched nothing", not a write that must be
// interpreted after the fact.
//
// The publish-token column may not exist yet: functions and app code deploy on
// merge, the migration is applied by hand. PostgREST answers PGRST204 for an
// unknown column in a write; latch and degrade to v2 writes (no native
// uploads) rather than taking live sharing off the air for the window.
let publishTokenColumnMissing = false;
const isColumnMissing = (err: { code?: string | null } | null) => err?.code === "PGRST204";

type WriteError = { code?: string | null; message?: string } | null;

async function writeRow(user_id: string, args: PublishArgs): Promise<void> {
  const { status, points, stats, startedAt, shareToken, onShareTokenRejected, onPublishTokenChanged } = args;
  const row = { status, points, stats };
  let share_token = shareToken ?? null;
  let publish_token = publishTokenColumnMissing ? null : (args.publishToken ?? null);
  // Two partial unique indexes, two distinct 23505s, two different responses.
  // The share token was HANDED to someone who can squat it (see the migration):
  // drop it, keep the broadcast. The publish token was handed to no one, so a
  // collision is pure bad luck: re-mint and retry, and tell the caller so the
  // native uploader is re-seeded with the replacement.
  const conflictIndex = (err: WriteError) =>
    err?.code === "23505"
      ? String(err.message || "").includes("live_runs_share_token_key") ? "share"
        : String(err.message || "").includes("live_runs_publish_token_key") ? "publish"
          : "row"
      : null;
  const dropShareToken = () => {
    share_token = null;
    storeShareToken(null);
    lastShareToken = null;
    onShareTokenRejected?.();
  };
  const remintPublishToken = () => {
    publish_token = mintPublishToken();
    storePublishToken(publish_token);
    onPublishTokenChanged?.(publish_token);
  };
  const tokens = () => (publishTokenColumnMissing
    ? { share_token }
    : { share_token, publish_token });
  try {
    if (rowCreated) {
      // Scoped to OUR tokened row: if another device's broadcast replaced it,
      // this must match nothing (and re-open via insert) rather than silently
      // stamping our tokens over their live run.
      const update = () => {
        let q = supabase.from("live_runs").update({ ...row, ...tokens() }).eq("user_id", user_id);
        if (publish_token) q = q.eq("publish_token", publish_token);
        return q.select("user_id");
      };
      let { data, error } = await update();
      if (isColumnMissing(error)) {
        publishTokenColumnMissing = true;
        publish_token = null;
        ({ data, error } = await update());
      }
      if (conflictIndex(error) === "share") {
        dropShareToken();
        ({ data, error } = await update());
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
    const insert = () =>
      supabase.from("live_runs").insert({ user_id, ...row, started_at, ...tokens() });
    let { error } = await insert();
    if (isColumnMissing(error)) {
      publishTokenColumnMissing = true;
      publish_token = null;
      ({ error } = await insert());
    }
    // Our OWN leftover row from a killed app is in the way — this run replaces
    // it wholesale. Checked against the index name so a token conflict isn't
    // "fixed" by deleting a perfectly good row of ours.
    if (conflictIndex(error) === "row") {
      await supabase.from("live_runs").delete().eq("user_id", user_id);
      ({ error } = await insert());
    }
    if (conflictIndex(error) === "share") {
      dropShareToken();
      ({ error } = await insert());
    }
    if (conflictIndex(error) === "publish") {
      remintPublishToken();
      ({ error } = await insert());
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
  // Both tokens die with the broadcast, whether or not the delete below lands:
  // a token that outlived its run would be re-published by the NEXT one —
  // silently reopening a link (or a write capability) minted for a run the
  // runner never shared. The row is what a viewer reads, and it is on its way
  // out either way.
  const publishToken = readPublishToken();
  storeShareToken(null);
  storePublishToken(null);
  if (!user_id) {
    // Signed out at save (an expired session must still be able to take the
    // run off the air): teardown by capability through the edge function.
    if (publishToken) {
      try {
        await fetch(`${SUPABASE_URL}/functions/v1/live-publish`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({ token: publishToken, end: true }),
        }).then((res) => { if (res.ok) clearPublishedMarker(); });
      } catch { /* best effort — the boot sweep stays on the hook */ }
    }
    return;
  }
  try {
    // Scoped to the row this run's token opened, so finishing on device A can
    // never take down a broadcast device B has since started (their insert
    // replaced ours and stamped THEIR token). No token known (a pre-token run,
    // or storage lost): fall back to the old own-row delete.
    let q = supabase.from("live_runs").delete().eq("user_id", user_id);
    if (publishToken && !publishTokenColumnMissing) q = q.eq("publish_token", publishToken);
    const { error } = await q;
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
  // A sweep resolves a broadcast this device left behind, so its tokens are
  // spent too. Done up front and unconditionally: with no marker there is
  // nothing on the air, and a token still sitting here is one minted for a run
  // that never started — exactly what the NEXT run must not inherit.
  storeShareToken(null);
  storePublishToken(null);
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
  // Re-probe once per run: if the migration landed mid-session the next run
  // picks the column back up; if not, the first write re-latches for free.
  publishTokenColumnMissing = false;
}
