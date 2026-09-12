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
import { LIVE_PUBLISHED_KEY, LIVE_RUN_KEY, LIVE_RUN_PUBLIC_KEY, RESUME_MAX_AGE_MS } from "../constants";
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
  share_public?: boolean;
};

type PublishArgs = {
  status: LiveRunStatus;
  points: TrackPointOrGap[];
  stats: LiveRunStats;
  startedAt?: number | null;
  // Whether this run is readable at the runner's standing share link. Carried
  // on every write so hiding or unhiding a run mid-run takes effect on the next
  // publish rather than the next run. False is the closed direction: a row this
  // client opens without it reaches the runner's own sessions only.
  sharePublic?: boolean;
  // The WRITE capability for the native screen-off uploader (v3). Carried on
  // every write like the share token; null only for a run started before the
  // token existed. Scopes the continuing UPDATE to the row THIS device opened.
  publishToken?: string | null;
  // Called when `share_public` can't be written at all (the migration hasn't
  // landed yet). Nothing will reach the public link for the rest of this run,
  // so the UI must stop offering one.
  onSharePublicUnavailable?: () => void;
  // Called when the publish token had to be re-minted (a 23505 on ITS index —
  // astronomically unlikely, but a distinct index means a distinct branch).
  // The caller must re-seed the native uploader with the replacement.
  onPublishTokenChanged?: (token: string) => void;
};

// Per-run publishing state. Module-level rather than a hook: the decision has to
// survive every re-render of the tracker, and there is only ever one run.
let lastPublishAt = 0;
let lastStatus: LiveRunStatus | null = null;
let lastSharePublic: boolean | null = null;
let inFlight = false;
let inFlightWrite: Promise<void> | null = null; // so teardown can wait it out
let rowCreated = false; // this run's row exists — later writes are plain UPDATEs
let blocked = false; // a policy rejection — stop hammering the API for this run

// Whether this call should actually hit the network. Pure so the cadence is
// testable without a Supabase client. A status transition (pause/resume/stop)
// always goes through: those are the updates a watcher most needs promptly, and
// they can't be re-triggered by a later GPS fix while paused.
//
// A change to the public flag bypasses the throttle for the same reason:
// HIDING a run must take it off the link now, not up to 30s from now — and a
// stationary runner emits no fixes to carry it out later. Unrelated to GPS, so
// nothing else would push it out promptly.
export function shouldPublish(
  { now, lastAt, status, prevStatus, busy, sharePublic = false, prevSharePublic = false }:
  { now: number; lastAt: number; status: LiveRunStatus; prevStatus: LiveRunStatus | null; busy: boolean;
    sharePublic?: boolean; prevSharePublic?: boolean | null },
): boolean {
  if (busy) return false;
  if (status !== prevStatus) return true;
  if (sharePublic !== prevSharePublic) return true;
  return now - lastAt >= LIVE_PUBLISH_INTERVAL_MS;
}

// Would a publish right now actually go out? Lets the caller skip the work of
// simplifying a long trace on the ~1/s renders that will be throttled anyway.
export function canPublishNow(status: LiveRunStatus, sharePublic = false): boolean {
  if (blocked) return false;
  return shouldPublish({ now: Date.now(), lastAt: lastPublishAt, status, prevStatus: lastStatus,
    busy: inFlight, sharePublic, prevSharePublic: lastSharePublic });
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
  const sharePublic = args.sharePublic ?? false;
  if (!shouldPublish({ now: Date.now(), lastAt: lastPublishAt, status: args.status, prevStatus: lastStatus,
    busy: inFlight, sharePublic, prevSharePublic: lastSharePublic })) {
    return Promise.resolve();
  }

  inFlight = true;
  // Claim the slot up front: an upload that takes longer than the interval must
  // not let the next fix queue a second one the moment it lands.
  lastPublishAt = Date.now();
  lastStatus = args.status;
  lastSharePublic = sharePublic;
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
// Either new column may not exist yet: functions and app code deploy on merge,
// the migration is applied by hand. PostgREST answers PGRST204 for an unknown
// column in a write; latch and degrade (no native uploads / no public link)
// rather than taking live sharing off the air for the window.
let publishTokenColumnMissing = false;
let sharePublicColumnMissing = false;

type WriteError = { code?: string | null; message?: string } | null;

async function writeRow(user_id: string, args: PublishArgs): Promise<void> {
  const { status, points, stats, startedAt, onPublishTokenChanged, onSharePublicUnavailable } = args;
  const row = { status, points, stats };
  let share_public = sharePublicColumnMissing ? null : (args.sharePublic ?? false);
  let publish_token = publishTokenColumnMissing ? null : (args.publishToken ?? null);
  // Two distinct 23505s on this table, two different responses. The legacy
  // share_token index can still be hit by an OLDER bundle on another device of
  // the same account (it is no longer written here), so a conflict naming it is
  // not our leftover row and must never make us delete one. The publish token
  // was handed to no one, so a collision is pure bad luck: re-mint and retry,
  // and tell the caller so the native uploader is re-seeded.
  const conflictIndex = (err: WriteError) =>
    err?.code === "23505"
      ? String(err.message || "").includes("live_runs_share_token_key") ? "share"
        : String(err.message || "").includes("live_runs_publish_token_key") ? "publish"
          : "row"
      : null;
  // PGRST204 names the column it couldn't find, which is the only thing that
  // tells the two pending-migration cases apart. Latching share_public also has
  // to reach the UI: a link offered over writes that can't carry the flag would
  // promise something nothing is publishing.
  const missingColumn = (err: WriteError): "publish_token" | "share_public" | null => {
    if (err?.code !== "PGRST204") return null;
    const msg = String(err.message || "");
    if (msg.includes("share_public")) return "share_public";
    if (msg.includes("publish_token")) return "publish_token";
    // Unnamed: assume the newer column, which is the one a deploy is most
    // likely to be ahead of.
    return "share_public";
  };
  const dropColumn = (which: "publish_token" | "share_public") => {
    if (which === "share_public") {
      sharePublicColumnMissing = true;
      share_public = null;
      onSharePublicUnavailable?.();
    } else {
      publishTokenColumnMissing = true;
      publish_token = null;
    }
  };
  const remintPublishToken = () => {
    publish_token = mintPublishToken();
    storePublishToken(publish_token);
    onPublishTokenChanged?.(publish_token);
  };
  const extras = () => ({
    ...(share_public === null ? {} : { share_public }),
    ...(publish_token === null ? {} : { publish_token }),
  });
  try {
    if (rowCreated) {
      // Scoped to OUR tokened row: if another device's broadcast replaced it,
      // this must match nothing (and re-open via insert) rather than silently
      // stamping our tokens over their live run.
      const update = () => {
        let q = supabase.from("live_runs").update({ ...row, ...extras() }).eq("user_id", user_id);
        if (publish_token) q = q.eq("publish_token", publish_token);
        return q.select("user_id");
      };
      let { data, error } = await update();
      for (let retry = 0; retry < 2; retry++) {
        const missing = missingColumn(error);
        if (!missing) break;
        dropColumn(missing);
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
      supabase.from("live_runs").insert({ user_id, ...row, started_at, ...extras() });
    let { error } = await insert();
    for (let retry = 0; retry < 2; retry++) {
      const missing = missingColumn(error);
      if (!missing) break;
      dropColumn(missing);
      ({ error } = await insert());
    }
    // Our OWN leftover row from a killed app is in the way — this run replaces
    // it wholesale. Checked against the index name so another device's token
    // conflict isn't "fixed" by deleting a perfectly good row of ours.
    if (conflictIndex(error) === "row") {
      await supabase.from("live_runs").delete().eq("user_id", user_id);
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
  // The publish token dies with the broadcast, whether or not the delete below
  // lands: a write capability that outlived its run would be re-used by the
  // NEXT one. The STANDING share link is deliberately untouched — it belongs to
  // the account, not to this run. What does die with the run is the per-run
  // public marker: the next run decides its own visibility from the remembered
  // preference, not from this one's.
  const publishToken = readPublishToken();
  storePublishToken(null);
  clearRunPublic();
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
  // A sweep resolves a broadcast this device left behind, so its per-run state
  // is spent too. Done up front and unconditionally: with no marker there is
  // nothing on the air, and a publish token still sitting here is one minted
  // for a run that never started — exactly what the NEXT run must not inherit.
  // The standing share link is account state and is never touched here.
  storePublishToken(null);
  clearRunPublic();
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

// Whether the CURRENT run is published to the standing link. Written here
// rather than held only in React state so a run recovered after an app kill
// comes back hidden if that is how the runner left it.
export const markRunPublic = (on: boolean) => {
  try { localStorage.setItem(LIVE_RUN_PUBLIC_KEY, on ? "1" : "0"); } catch { /* quota — non-fatal */ }
};
export const readRunPublic = (): boolean | null => {
  try {
    const v = localStorage.getItem(LIVE_RUN_PUBLIC_KEY);
    return v === null ? null : v === "1";
  } catch { return null; }
};
const clearRunPublic = () => {
  try { localStorage.removeItem(LIVE_RUN_PUBLIC_KEY); } catch { /* ignore */ }
};

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
  // Only the module's memory of what was last written. The per-run PUBLIC
  // marker is deliberately untouched: a recovered run has to come back at the
  // visibility the runner left it at, and endLiveRun is what spends it.
  lastSharePublic = null;
  inFlight = false;
  inFlightWrite = null;
  rowCreated = false;
  blocked = false;
  // Re-probe once per run: if the migration landed mid-session the next run
  // picks the columns back up; if not, the first write re-latches for free.
  publishTokenColumnMissing = false;
  sharePublicColumnMissing = false;
}
