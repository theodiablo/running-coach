// Live run sharing, the watcher half: follows the user's own `live_runs` row so another
// session can watch. Mounted ONCE (RunningCoach) and threaded via `shared`. Load: one
// select on activation, then Realtime pushes; polling only as a fallback while
// Realtime is down and the page is visible.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../supabase";
import { RESUME_MAX_AGE_MS } from "../constants";
import type { LiveRunRow } from "../live/publisher";

// Matches the publisher's cadence: reading faster than the phone writes can only
// return what we already have.
const POLL_MS = 30000;
// With nothing live there is nothing to follow, only a start to notice — so keep
// checking (a run can begin at any time and Realtime is what would have told us),
// just rarely enough that a broken websocket isn't expensive.
const IDLE_POLL_MS = 120000;

// Past this, a row is treated as leftover rather than live — an app killed
// mid-run leaves one behind, and only the recording device can sweep it.
// Mirrors the tracker's own resume window.
const MAX_AGE_MS = RESUME_MAX_AGE_MS;

export type LiveRun = {
  row: LiveRunRow | null;
  // Whether a row is present, not ended, and fresh enough to be worth showing.
  active: boolean;
  refresh: () => void;
};

export function useLiveRun(uid: string | null | undefined): LiveRun {
  const [fetched, setFetched] = useState<LiveRunRow | null>(null);
  // Derived, not cleared in an effect: a sign-out must hide the row on the very
  // next render, without a cascading setState.
  const row = uid ? fetched : null;
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

  // Realtime subscription plus the one snapshot read. The read runs from the subscribe
  // callback so an update between snapshot and subscription can't slip through; it also
  // runs on a FAILED status so a blocked websocket still gets its initial read.
  useEffect(() => {
    if (!uid) return;
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
  }, [uid, fetchRow]);

  const active = isActive(row);

  // Cheap catch-up when the user comes back to the app: one read, no timer. The
  // visibility is also held in state, because it gates the poll below.
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    if (!uid) return;
    const onVis = () => {
      const now = document.visibilityState === "visible";
      setVisible(now);
      if (now) void fetchRow();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [uid, fetchRow]);

  // Fallback polling for when Realtime can't be established. NOT gated on `active`:
  // with Realtime down, `active` only becomes true through this poll. Cadence instead:
  // 30s while a run is live, slow otherwise, paused while the tab is hidden.
  useEffect(() => {
    if (!uid || realtimeOk || !visible) return;
    const id = setInterval(() => { void fetchRow(); }, active ? POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(id);
  }, [uid, realtimeOk, visible, active, fetchRow]);

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
