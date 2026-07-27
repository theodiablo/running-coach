// Live run sharing — the watcher half.
//
// Follows the signed-in user's own `live_runs` row so another of their sessions
// can watch a run as it happens. Mounted ONCE (in RunningCoach) and threaded
// through the `shared` bag, so the dashboard banner and the watch modal read one
// subscription rather than opening one each.
//
// Load discipline, in order of preference:
//   1. one select when the hook activates,
//   2. Realtime pushes for everything after that,
//   3. a 30s poll ONLY as a fallback, and only while a run is actually live —
//      polling for a row we know isn't there buys nothing, so when nothing is
//      live we simply re-check when the page becomes visible again.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../supabase";
import type { LiveRunRow } from "../live/publisher";

// Matches the publisher's cadence: reading faster than the phone writes can only
// return what we already have.
const POLL_MS = 30000;

// Past this, a row is treated as leftover rather than live — an app killed
// mid-run leaves one behind, and the boot sweep only runs on the recorder's own
// device. Mirrors the tracker's own resume window.
const MAX_AGE_MS = 6 * 3600 * 1000;

export type LiveRun = {
  row: LiveRunRow | null;
  // Whether a row is present, not ended, and fresh enough to be worth showing.
  active: boolean;
  refresh: () => void;
};

export function useLiveRun(uid: string | null | undefined, enabled: boolean): LiveRun {
  const [fetched, setFetched] = useState<LiveRunRow | null>(null);
  // Derived, not cleared in an effect: a sign-out or a lapsed entitlement must
  // hide the row on the very next render, without a cascading setState.
  const row = enabled && uid ? fetched : null;
  // Realtime is the happy path; polling only fills in when the channel can't be
  // established (blocked websocket, project without Realtime).
  const [realtimeOk, setRealtimeOk] = useState(true);
  const aliveRef = useRef(true);

  const fetchRow = useCallback(async () => {
    if (!uid) return;
    try {
      const { data, error } = await supabase
        .from("live_runs")
        .select("user_id, status, started_at, updated_at, points, stats")
        .eq("user_id", uid)
        .maybeSingle();
      if (error || !aliveRef.current) return;
      setFetched((data as LiveRunRow) || null);
    } catch {
      /* offline — the next refresh picks it up */
    }
  }, [uid]);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // Realtime subscription, plus the one snapshot read.
  //
  // The read is deliberately made from the subscribe callback rather than up
  // front: doing it after the channel settles means an update landing between
  // the snapshot and the subscription can't slip through the gap. It runs on a
  // FAILED status too, so a blocked websocket still gets its initial read and
  // then falls through to polling.
  useEffect(() => {
    if (!enabled || !uid) return;
    const channel = supabase
      .channel(`live_runs:${uid}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "live_runs", filter: `user_id=eq.${uid}` },
        payload => {
          if (!aliveRef.current) return;
          if (payload.eventType === "DELETE") setFetched(null);
          else setFetched(payload.new as LiveRunRow);
        },
      )
      .subscribe(status => {
        if (!aliveRef.current) return;
        if (status === "SUBSCRIBED") setRealtimeOk(true);
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") setRealtimeOk(false);
        else return; // still connecting — nothing settled yet
        void fetchRow();
      });
    return () => { void supabase.removeChannel(channel); };
  }, [enabled, uid, fetchRow]);

  const active = isActive(row);

  // Fallback polling — deliberately narrow: only when Realtime is down AND
  // there is a live run to follow. With nothing live there is nothing to poll
  // for, and the visibility refresh below covers "a run started while I was
  // away" without a standing timer.
  useEffect(() => {
    if (!enabled || !uid || realtimeOk || !active) return;
    const id = setInterval(() => { void fetchRow(); }, POLL_MS);
    return () => clearInterval(id);
  }, [enabled, uid, realtimeOk, active, fetchRow]);

  // Cheap catch-up when the user comes back to the app: one read, no timer.
  useEffect(() => {
    if (!enabled || !uid) return;
    const onVis = () => { if (document.visibilityState === "visible") void fetchRow(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [enabled, uid, fetchRow]);

  return { row, active, refresh: fetchRow };
}

// Exported for tests: a row is worth surfacing while it isn't ended and hasn't
// gone stale. "Stale" is generous on purpose — a runner standing still emits no
// GPS fixes and so publishes nothing, and that must never read as "not running".
export function isActive(row: LiveRunRow | null, now: number = Date.now()): boolean {
  if (!row || row.status === "ended") return false;
  const t = Date.parse(row.updated_at);
  return Number.isFinite(t) && now - t < MAX_AGE_MS;
}
