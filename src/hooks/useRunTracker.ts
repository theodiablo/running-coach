import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { INDOOR_RUN_KEY, LIVE_RUN_KEY } from "../constants";
import { accuracyOK, distanceKm, elevGainM, haversineM } from "../utils/geo";
import { hrSummary } from "../utils/hr";
import { geoSource } from "../geo/source";
import { pushRunNotification, resetRunNotification } from "../geo/liveNotification";
import { buildRunNotificationContent } from "../utils/runNotification";
import { logTrack } from "../geo/trackLog";
import { clearNativeFixJournal, readNativeFixJournal } from "../geo/fixJournal";
import { normalizeRecovery, readRecoveryBuffer, type RecoveredRun } from "../utils/runRecovery";
import { getHrSource } from "../hr/source";
import { armHrJournal, clearHrJournal, disarmHrJournal, resetHrJournal } from "../hr/hrJournal";
import { startIndoorSessionService, stopIndoorSessionService } from "../indoor/session";
import { getPairedDevice, setPairedDevice } from "../hr/device";
import { isAndroid, isNative } from "../native";
import { clearRecorderMarks, markTick } from "../diag/frameHeartbeat";
import { t } from "../i18n";
import type { BleHrSample, BleWatchHandle, BleWatchStatus } from "../hr/ble";
import type { StoredTrackPoint } from "../utils/geo";

// Live GPS run tracker. All geolocation access is funnelled through this one hook
// so a Phase-2 native shell can swap watchPosition for a background-location
// plugin behind the same interface without touching any UI.
//
// A point is [lat, lng, tEpochMs, altMeters|null]; a `null` entry marks a gap
// where GPS was lost (signal/background) so the route isn't bridged with a
// straight line.

const ACC_MAX_M = 25;        // drop fixes worse than this (tighter = cleaner track)
const ACC_WARMUP_M = 20;     // require a fix at least this good before the FIRST point —
                             // the GNSS chip emits coarse network fixes until satellites lock
const MIN_INTERVAL_MS = 2000; // thin the stream to ~1 point / 2s (battery/storage)
const MIN_HR_PERSIST_MS = 5000; // HR samples land far more often than GPS fixes (~1/s vs
                                 // ~1/2s); persisting the whole recovery buffer on every one
                                 // would make a multi-hour run rewrite it constantly, so a
                                 // sample only triggers a fresh persist at most this often —
                                 // losing a few seconds of HR to a crash is fine.
const MIN_MOVE_M = 5;         // base jitter gate (scaled up for less-accurate fixes below)
const GAP_MS = 60000;         // silence longer than this starts a new segment (gap).
                             // Sized for native background location, which batches
                             // fixes tens of seconds apart — those are real positions,
                             // not lost signal, so we don't break the track over them.
const TICK_MS = 1000;         // UI clock refresh while tracking
const BUFFER_TICK_MS = 10000; // foreground floor for refreshing the recovery buffer
const CUR_PACE_WINDOW_MS = 30000; // current-pace look-back

// Permission-denied copy, shared by onErr and requestPermissions so the native
// and web wording can't drift between the two. isNative is fixed at module load;
// the message is resolved via t() at call time so a runtime language switch applies.
// Covers both causes ensureForegroundPermission can now fail for — the OS
// permission was declined, OR the device's Location Services are switched off —
// since from here we can't always tell which one it was.
const permissionDeniedMsg = () => isNative
  ? t("tracker.errors.permissionDeniedNative")
  : t("tracker.errors.permissionDeniedWeb");

type TrackerState = "idle" | "tracking" | "paused" | "stopped";
type TrackPointOrGap = StoredTrackPoint | null;
type LocationPreview = { lat: number; lng: number; acc: number | null };
type GeoPosition = {
  coords: { latitude: number; longitude: number; altitude?: number | null; accuracy?: number | null };
  timestamp?: number;
};
type GeoError = {
  code: number;
  message?: string;
  PERMISSION_DENIED: number;
  POSITION_UNAVAILABLE: number;
  TIMEOUT: number;
};
type GeoWatchHandle = number | { id: string | null; removed: boolean; background: boolean };
type TrackerGeoSource = {
  isAvailable: () => boolean;
  checkPermissions: () => Promise<boolean>;
  requestPermissions: () => Promise<boolean>;
  watchPosition: (onPos: (position: GeoPosition) => void, onErr?: (error: GeoError) => void, opts?: { background?: boolean }) => GeoWatchHandle;
  clearWatch: (handle: GeoWatchHandle | null | undefined) => void;
};
const trackerGeoSource = geoSource as TrackerGeoSource;

// The live HR source, narrowed by the `live` discriminant (post-run sources
// have live:false and are never watched here).
type LiveHrSource = Extract<NonNullable<ReturnType<typeof getHrSource>>, { live: true }>;

type UseRunTrackerOptions = {
  hrMethod?: string;
  // Guided-workout step line for the lock-screen surfaces (null = unguided).
  stepText?: string | null;
  // Indoor/static cardio session (stationary bike, elliptical): record time and
  // heart rate with NO geolocation at all — see docs/indoor-sessions.md. Turns
  // off the position watch, the idle position preview, the Android fix journal
  // and the lock-screen notification (which the location foreground service
  // renders), and moves the recovery buffer to its own key. The clock, the wake
  // lock and the live HR watch are untouched, and with a live strap the session
  // runs its own foreground service instead (src/indoor/session.ts).
  indoor?: boolean;
};

// `hrMethod` (settings.hrMethod) selects an optional live heart-rate source. A
// LIVE source (Bluetooth) streams here alongside GPS; a post-run source (Health
// Connect) is handled at save time in LiveRunTracker, not here. Absent/web → no HR.
export function useRunTracker({ hrMethod, stepText, indoor = false }: UseRunTrackerOptions = {}) {
  // One buffer per mode: an indoor session has no points, so it must never
  // surface in the GPS resume offer or the Dashboard's interrupted-run banner —
  // and an indoor reset must never wipe a real run's recovery data.
  const bufferKey = indoor ? INDOOR_RUN_KEY : LIVE_RUN_KEY;
  const clearBuffer = useCallback(() => {
    try { localStorage.removeItem(bufferKey); } catch { /* ignore */ }
  }, [bufferKey]);

  const [state, setState] = useState<TrackerState>("idle");
  const [points, setPoints] = useState<TrackPointOrGap[]>([]);
  const [hrSamples, setHrSamples] = useState<BleHrSample[]>([]); // { bpm, t } from a live HR sensor
  const [hrLast, setHrLast] = useState<BleHrSample | null>(null); // latest sample off the sensor, incl. the idle preview before Start
  const [hrStatus, setHrStatus] = useState<BleWatchStatus | null>(null); // live sensor connection status (null = no live watch)
  const [error, setError] = useState<string | null>(null);
  const [movingSec, setMovingSec] = useState(0);
  const [location, setLocation] = useState<LocationPreview | null>(null); // preview position shown before recording starts
  // Whether location is usable. On the web the browser handles its own prompt, so
  // the idle preview can always run (true). On native it gates the preview so we
  // never auto-prompt out of context — it flips true once permission is granted
  // (already-granted users via the check below, or via the consent accept flow).
  const [permGranted, setPermGranted] = useState(!isNative);
  // A recoverable in-progress run from a previous session, read once on mount.
  // Offered whatever its age — an old buffer is still the runner's data, so it
  // is resolved by an explicit resume/discard, never expired away silently.
  // (RESUME_MAX_AGE_MS only bounds the live-sharing sweep, not this offer.)
  const [pending, setPending] = useState<RecoveredRun | null>(() => {
    const buf = readRecoveryBuffer(bufferKey, { requirePoints: !indoor });
    return buf ? normalizeRecovery(buf) : null;
  });

  const stateRef = useRef(state);
  const pointsRef = useRef(points);
  const hrSamplesRef = useRef(hrSamples); // mirror so the async HR callback sees latest
  const lastHrPersistRef = useRef(0); // epoch ms of the last HR-triggered persist (throttle)
  const lastBufferPersistRef = useRef(0); // epoch ms of the last clock-tick persist (throttle)
  // Live HR watch: the handle AND the source it came from, so teardown always
  // reaches the source that opened the connection even if hrMethod has since
  // changed (a re-resolved source could be null → leaked BLE connection).
  const hrWatchRef = useRef<{ src: LiveHrSource; handle: BleWatchHandle } | null>(null);
  const runStartRef = useRef<number | null>(null); // wall-clock run start (whole run, incl. pauses)
  const runEndRef = useRef<number | null>(null);   // wall-clock run stop — the Health Connect fetch window
  const accRef = useRef(0);        // completed moving seconds
  const startRef = useRef<number | null>(null);   // epoch ms the current active segment began
  const watchRef = useRef<GeoWatchHandle | null>(null);
  const wakeRef = useRef<WakeLockSentinel | null>(null);
  const lastFixRef = useRef(0);    // epoch ms of the last usable fix (incl. ones
                                   // dropped as jitter) — for true gap detection

  // Mirror render state into refs from effects (not during render) so the async
  // geolocation callback always sees the latest values.
  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { pointsRef.current = points; }, [points]);
  useEffect(() => { hrSamplesRef.current = hrSamples; }, [hrSamples]);

  const persist = useCallback(() => {
    try {
      localStorage.setItem(bufferKey, JSON.stringify({
        points: pointsRef.current, accSec: accRef.current, hrSamples: hrSamplesRef.current,
        startAt: startRef.current, startedAt: runStartRef.current, stoppedAt: runEndRef.current,
        state: stateRef.current, savedAt: Date.now(),
      }));
    } catch { /* quota — non-fatal */ }
  }, [bufferKey]);

  // Moving seconds = completed segments + the current live one. Read only from
  // effects/handlers, never during render.
  const computeMoving = useCallback(() => Math.round(
    accRef.current + (stateRef.current === "tracking" && startRef.current ? (Date.now() - startRef.current) / 1000 : 0)
  ), []);

  // ── wake lock ──────────────────────────────────────────────────────────
  const acquireWake = useCallback(async () => {
    try {
      if ("wakeLock" in navigator) wakeRef.current = await navigator.wakeLock.request("screen");
    } catch { /* denied / unsupported — fine */ }
  }, []);
  const releaseWake = useCallback(() => {
    try { wakeRef.current?.release?.(); } catch { /* ignore */ }
    wakeRef.current = null;
  }, []);

  // ── geolocation callback ─────────────────────────────────────────────────
  const onPos = useCallback((pos: GeoPosition) => {
    // Log the raw arrival BEFORE any filtering — the key diagnostic signal is
    // whether fixes keep landing at the JS boundary while the app is backgrounded
    // (screen off). A no-op unless GPS debug is enabled.
    const acc0 = pos.coords.accuracy ?? null;
    const t0 = pos.timestamp || Date.now();
    logTrack("native-fix", { t: t0, acc: acc0, sinceMs: lastFixRef.current ? t0 - lastFixRef.current : undefined });
    if (stateRef.current !== "tracking") { logTrack("drop", { t: t0, acc: acc0, msg: "paused" }); return; } // ignore fixes while paused
    if (!accuracyOK(pos, ACC_MAX_M)) { logTrack("drop", { t: t0, acc: acc0, msg: "accuracy" }); return; }
    const { latitude, longitude, altitude, accuracy } = pos.coords;
    const t = pos.timestamp || Date.now();
    // Silence since the last usable fix. Measured against every accepted fix
    // (even ones we then drop as jitter), NOT the last stored point, so standing
    // still — which keeps producing fixes — doesn't masquerade as a lost signal.
    const sinceLastFix = lastFixRef.current ? t - lastFixRef.current : 0;
    lastFixRef.current = t;
    const pts = pointsRef.current;
    let last: StoredTrackPoint | null = null;
    for (let i = pts.length - 1; i >= 0; i--) { if (pts[i]) { last = pts[i]; break; } }
    let next = pts;
    if (last) {
      if (t - last[2] < MIN_INTERVAL_MS) { logTrack("drop", { t, acc: accuracy ?? null, msg: "too-soon" }); return; }          // too soon
      // Reject a move smaller than the fix's own uncertainty as jitter, so a
      // less-accurate fix can't zigzag the track or inflate distance. Accurate
      // fixes fall back to the flat MIN_MOVE_M floor.
      const minMove = Math.max(MIN_MOVE_M, (accuracy || 0) * 0.5);
      if (haversineM(last, [latitude, longitude]) < minMove) { logTrack("drop", { t, acc: accuracy ?? null, msg: "jitter" }); return; } // not moving
      if (sinceLastFix > GAP_MS) { next = [...pts, null]; logTrack("gap", { t, sinceMs: sinceLastFix }); }   // lost signal → break track
    } else if (accuracy == null || accuracy > ACC_WARMUP_M) {
      // Warm-up: don't anchor the track on a coarse — or unknown-accuracy — pre-lock
      // fix. The web GeolocationPosition always carries a numeric accuracy, so this
      // is unchanged for web; it only tightens the native path, where a plugin fix
      // can report null accuracy (the next fix with a known-good reading anchors).
      logTrack("drop", { t, acc: accuracy ?? null, msg: "warmup" });
      return;
    }
    const np: StoredTrackPoint = [latitude, longitude, t, altitude == null ? null : Math.round(altitude)];
    pointsRef.current = [...next, np];
    setPoints(pointsRef.current);
    logTrack("fix", { t, acc: accuracy ?? null, sinceMs: sinceLastFix });
    persist();
  }, [persist]);

  // ── live heart-rate callback ─────────────────────────────────────────────
  // Append a sample only while actively tracking (mirrors onPos ignoring fixes
  // when paused) so a paused breather doesn't drag the average down — the live
  // BPM readout above is fed by `hrLast` in every state instead, including the
  // idle preview. The state update always happens, but persisting the
  // whole recovery buffer is throttled to MIN_HR_PERSIST_MS — a strap notifies
  // at sensor rate (~1/s), and GPS fixes already keep the buffer fresh every
  // ~2s via onPos's own persist() while a run is actually moving.
  const onHrSample = useCallback((sample: BleHrSample) => {
    setHrLast(sample); // display-only, so it also lands during the idle preview
    if (stateRef.current !== "tracking") return;
    hrSamplesRef.current = [...hrSamplesRef.current, sample];
    setHrSamples(hrSamplesRef.current);
    const now = Date.now();
    if (now - lastHrPersistRef.current >= MIN_HR_PERSIST_MS) {
      lastHrPersistRef.current = now;
      persist();
    }
  }, [persist]);

  const startHrWatch = useCallback(() => {
    if (hrWatchRef.current) return; // already streaming (e.g. resume)
    const src = getHrSource(hrMethod);
    if (!src || !src.live || !("watch" in src)) return;  // off / web / post-run source → nothing to stream
    const device = getPairedDevice();
    if (!device?.id) return;
    const handle = src.watch(onHrSample, () => { /* non-fatal; run continues */ }, {
      deviceId: device.id,
      deviceName: device.name,
      // Re-discovery followed an address rotation — persist the new id so the
      // next session connects directly again.
      onDeviceChange: setPairedDevice,
      onStatus: setHrStatus,
    });
    hrWatchRef.current = { src, handle };
  }, [hrMethod, onHrSample]);

  const stopHrWatch = useCallback(() => {
    const watching = hrWatchRef.current;
    if (watching) watching.src.clearWatch(watching.handle);
    hrWatchRef.current = null;
    setHrStatus(null);
  }, []);

  const onErr = useCallback((err: GeoError) => {
    logTrack("error", { msg: `code=${err.code} ${err.message || ""}`.trim() });
    if (err.code === err.PERMISSION_DENIED)
      setError(permissionDeniedMsg());
    else if (err.code === err.POSITION_UNAVAILABLE)
      setError(t("tracker.errors.noFix"));
    else if (err.code === err.TIMEOUT)
      setError(t("tracker.errors.timeout"));
    else setError(t("tracker.errors.location", { message: err.message }));
  }, []);

  const startWatch = useCallback(() => {
    if (indoor) return true; // no geolocation at all — the whole point of the mode
    if (!trackerGeoSource.isAvailable()) {
      setError(t("tracker.errors.unsupported"));
      return false;
    }
    // background:true → the native source runs a foreground service so recording
    // continues with the screen off; on web the flag is ignored (no-op).
    watchRef.current = trackerGeoSource.watchPosition(onPos, onErr, { background: true });
    return true;
  }, [onPos, onErr, indoor]);

  const stopWatch = useCallback(() => {
    if (watchRef.current != null) trackerGeoSource.clearWatch(watchRef.current);
    watchRef.current = null;
  }, []);

  // Proactively request the OS location permission (native), so the prompt can be
  // shown as part of the consent flow rather than only when recording starts.
  // Returns whether location is usable; sets an actionable error if denied.
  const requestPermissions = useCallback(async () => {
    try {
      const granted = await trackerGeoSource.requestPermissions();
      if (!granted) {
        setError(permissionDeniedMsg());
        return false;
      }
      setError(null);
      setPermGranted(true); // unlocks the idle position preview on native
      return true;
    } catch {
      setError(t("tracker.errors.requestFailed"));
      return false;
    }
  }, []);

  // ── controls ─────────────────────────────────────────────────────────────
  const start = useCallback(() => {
    setError(null);
    // A fresh run must not inherit a previous run's journal — but an indoor
    // session writes no journal, so clearing it would only destroy a real run's
    // unrecovered background points.
    if (!indoor) clearNativeFixJournal();
    pointsRef.current = [];
    setPoints([]);
    hrSamplesRef.current = [];
    setHrSamples([]);
    lastHrPersistRef.current = 0;
    accRef.current = 0;
    startRef.current = Date.now();
    runStartRef.current = Date.now();
    runEndRef.current = null;
    lastFixRef.current = 0;
    if (!startWatch()) return;
    stateRef.current = "tracking";
    setState("tracking");
    logTrack("start", { msg: isNative ? "native" : "web" });
    setMovingSec(0);
    startHrWatch();
    // Journal natively only when a live sensor is actually streaming — the
    // journal exists to cover the stretches where this JS isn't running. With no
    // live watch there is still a file to clear: a previous BLE run killed before
    // it saved leaves its beats on disk, and they must never surface as this
    // run's heart rate.
    if (hrWatchRef.current) resetHrJournal(); else clearHrJournal();
    // An indoor session has no location service to hold the process, so it runs
    // its own — but only with a live strap streaming, which is what makes its
    // connectedDevice type honest (src/indoor/session.ts).
    if (indoor && hrWatchRef.current) startIndoorSessionService(runStartRef.current);
    acquireWake();
    persist();
  }, [startWatch, startHrWatch, acquireWake, persist, indoor]);

  const pause = useCallback(() => {
    if (stateRef.current !== "tracking") return;
    if (startRef.current) accRef.current += (Date.now() - startRef.current) / 1000;
    startRef.current = null;
    stateRef.current = "paused";
    setState("paused");
    logTrack("pause");
    setMovingSec(computeMoving());
    // The journal has to observe the same pause onHrSample does. It keeps
    // recording natively otherwise, and the merge at save would fold a rest
    // back into the run — dragging the average down and crediting zone 1 with
    // time the runner spent standing still.
    disarmHrJournal();
    if (indoor) stopIndoorSessionService();
    releaseWake();
    persist();
  }, [releaseWake, persist, computeMoving, indoor]);

  const resume = useCallback(() => {
    if (stateRef.current !== "paused") return;
    startRef.current = Date.now();
    if (watchRef.current == null) startWatch();
    stateRef.current = "tracking";
    setState("tracking");
    logTrack("resume");
    startHrWatch();
    // Re-arm without clearing: arming is process state, so a run resumed after
    // the app was killed would otherwise journal nothing from here on, and the
    // beats already on disk are the ones the crash would have cost us.
    if (hrWatchRef.current) armHrJournal();
    if (indoor && hrWatchRef.current) startIndoorSessionService(runStartRef.current);
    acquireWake();
    persist();
  }, [startWatch, startHrWatch, acquireWake, persist, indoor]);

  const stop = useCallback(() => {
    if (stateRef.current === "tracking" && startRef.current)
      accRef.current += (Date.now() - startRef.current) / 1000;
    startRef.current = null;
    runEndRef.current = Date.now();
    stopWatch();
    stopHrWatch();
    // Stop journalling but keep the contents — handleSave still has to read them.
    disarmHrJournal();
    if (indoor) stopIndoorSessionService();
    releaseWake();
    stateRef.current = "stopped";
    setState("stopped");
    logTrack("stop", { msg: `pts=${pointsRef.current.filter(Boolean).length}` });
    setMovingSec(computeMoving());
    persist();
  }, [stopWatch, stopHrWatch, releaseWake, persist, computeMoving, indoor]);

  const reset = useCallback(() => {
    stopWatch();
    stopHrWatch();
    disarmHrJournal();
    clearHrJournal();
    if (indoor) stopIndoorSessionService();
    releaseWake();
    pointsRef.current = [];
    setPoints([]);
    hrSamplesRef.current = [];
    setHrSamples([]);
    setHrLast(null);
    lastHrPersistRef.current = 0;
    accRef.current = 0;
    startRef.current = null;
    runStartRef.current = null;
    runEndRef.current = null;
    lastFixRef.current = 0;
    setError(null);
    setMovingSec(0);
    stateRef.current = "idle";
    setState("idle");
    clearBuffer();
    if (!indoor) clearNativeFixJournal();
  }, [stopWatch, stopHrWatch, releaseWake, clearBuffer, indoor]);

  // Load a recoverable buffer into an active (paused) session.
  const resumePrevious = useCallback(() => {
    setPending(prev => {
      const buf = prev;
      if (!buf) return prev;
      // Break the track between the recovered points and whatever gets recorded
      // next: an unknown amount of time may have passed since the crash, so the
      // join is a gap (drawn dashed, not a solid recorded line). Note distanceKm
      // still bridges it with the straight-line minimum — fine for an in-run
      // crash, but if the runner travelled by other means before resuming that
      // leg will be counted; the runner can edit the saved distance if so.
      const recovered = [...(buf.points || [])];
      if (recovered.length && recovered[recovered.length - 1] != null) recovered.push(null);
      pointsRef.current = recovered;
      setPoints(pointsRef.current);
      hrSamplesRef.current = buf.hrSamples || [];
      setHrSamples(hrSamplesRef.current);
      accRef.current = buf.accSec || 0;
      runStartRef.current = buf.startedAt || null; // preserve the run window across a crash
      runEndRef.current = null;
      startRef.current = null;
      lastFixRef.current = 0;
      setError(null);
      setMovingSec(Math.round(buf.accSec || 0));
      stateRef.current = "paused"; // user taps Resume to continue recording
      setState("paused");
      return null;
    });
  }, []);

  const discardPrevious = useCallback(() => {
    clearBuffer();
    if (!indoor) clearNativeFixJournal();
    // The HR journal is NOT indoor-guarded like the fix journal above: an
    // indoor session streams the same strap and writes the same file, so it
    // owns clearing it too.
    clearHrJournal(); // same reason as the fix journal: the run is being thrown away
    setPending(null);
  }, [clearBuffer, indoor]);

  // Call after a successful save. The journals go with the buffer: all three
  // describe a run that is now safely stored as a real Run + route.
  const finalize = useCallback(() => {
    clearBuffer();
    if (!indoor) clearNativeFixJournal();
    clearHrJournal();
  }, [clearBuffer, indoor]);

  // ── effects ──────────────────────────────────────────────────────────────
  // UI clock while actively tracking, which also keeps the recovery buffer from
  // going stale. A GPS run persists on every accepted fix and a strapped session
  // every MIN_HR_PERSIST_MS of samples, but a strapless indoor session writes
  // NOTHING between Start and the next control change or page-hide — so losing
  // the process in the foreground (a killed WebView renderer fires no
  // visibilitychange) took the whole clock with it. Foreground-only by nature:
  // this interval is frozen in the background, where page-hide has already run.
  useEffect(() => {
    if (state !== "tracking") return;
    const id = setInterval(() => {
      markTick(); // diagnostics: proves this timer is still firing (see frameHeartbeat)
      setMovingSec(computeMoving());
      const now = Date.now();
      if (now - lastBufferPersistRef.current >= BUFFER_TICK_MS) {
        lastBufferPersistRef.current = now;
        persist();
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [state, computeMoving, persist]);

  // Re-acquire the wake lock when returning to the foreground (it auto-releases
  // when the page hides) and flush the buffer on hide.
  useEffect(() => {
    const onVis = () => {
      const tracking = stateRef.current === "tracking" || stateRef.current === "paused";
      if (document.visibilityState === "visible") {
        if (tracking) logTrack("visible");
        // Correct the clock NOW rather than waiting for the next tick. The 1s
        // interval below is a timer, and Chromium throttles timers in a hidden
        // page — to one wake-up per MINUTE once it has been hidden five minutes.
        // So on picking the phone up the displayed time could sit unchanged for
        // up to a minute before the interval next fired, with distance frozen
        // beside it (a runner standing still produces no accepted fix, so
        // nothing else re-renders either). Two frozen numbers and a map that
        // isn't moving read as a dead app — which is precisely what was
        // reported, right after a 15-minute backgrounded stretch.
        // computeMoving is wall-clock, so one call is a full correction.
        if (tracking) setMovingSec(computeMoving());
        if (stateRef.current === "tracking") acquireWake();
      } else {
        if (tracking) logTrack("hidden");
        persist();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [acquireWake, persist, computeMoving]);

  // Tear down on unmount. The indoor service goes too — it holds the process,
  // so leaking it would pin a notification to a session that no longer exists.
  useEffect(() => () => {
    stopWatch(); stopHrWatch(); releaseWake();
    clearRecorderMarks(); // nothing is rendering a recorder any more — see frameHeartbeat
    if (indoor) stopIndoorSessionService();
  }, [stopWatch, stopHrWatch, releaseWake, indoor]);

  // Android: extend a recovered buffer with the native fix journal — the points
  // the foreground service kept writing to disk after the WebView froze, which
  // the localStorage buffer (written by JS) can never contain. Runs once on
  // mount; a resolved offer (pending already null) is never resurrected by the
  // async read landing late.
  useEffect(() => {
    if (!isAndroid || indoor) return; // an indoor session records no fixes
    const buf = readRecoveryBuffer();
    if (!buf) return;
    let cancelled = false;
    readNativeFixJournal().then(journal => {
      if (cancelled || !journal.length) return;
      setPending(prev => (prev ? normalizeRecovery(buf, journal) : prev));
    });
    return () => { cancelled = true; };
  }, [indoor]);

  // Native, returning user: location may already be granted from a prior session.
  // Check WITHOUT prompting so the idle preview can show straight away (the lazy
  // initial state covers the web, which is always true).
  useEffect(() => {
    if (!isNative || indoor) return;
    let cancelled = false;
    trackerGeoSource.checkPermissions()
      .then(ok => { if (!cancelled && ok) setPermGranted(true); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [indoor]);

  // Live preview fix while idle so the user can see their position AND its
  // accuracy (the map draws a circle around it) and calibrate before hitting
  // Start. Runs only in idle; the cleanup stops it the moment recording begins,
  // and the last value persists so the map stays pinned through the transition.
  // Silent on error — recording's own watch surfaces permission issues.
  useEffect(() => {
    if (state !== "idle" || indoor) return;
    if (!trackerGeoSource.isAvailable()) return;
    // On native, only after permission is granted — never auto-prompt out of
    // context before the disclosure. Once granted (returning user, or via the
    // consent accept), the preview shows the current position + accuracy just like
    // the web build. The web is always permitted (permGranted starts true).
    if (!permGranted) return;
    // Foreground-only preview (background:false) — no foreground service /
    // notification while the user is still on the start screen.
    const handle = trackerGeoSource.watchPosition(
      pos => setLocation({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        acc: pos.coords.accuracy ?? null,
      }),
      () => {},
      { background: false },
    );
    return () => trackerGeoSource.clearWatch(handle);
  }, [state, permGranted, indoor]);

  // Connect a LIVE heart-rate source (Bluetooth strap) as soon as the tracker is
  // idle — the same "see it before you commit" contract as the position preview
  // above: the runner can check the strap is picking them up while GPS settles,
  // and the run then starts on an already-connected sensor instead of waiting
  // out the connect/subscribe round-trip. No-op for "off"/web/post-run sources
  // and when nothing is paired (startHrWatch's own guards). Deliberately NOT
  // torn down on the idle → tracking transition: the watch carries straight into
  // the run (start's startHrWatch is then a no-op), and stop/reset/unmount own
  // the teardown. Samples arriving before Start are display-only — onHrSample
  // records into hrSamples only while tracking.
  useEffect(() => {
    if (state === "idle") startHrWatch();
  }, [state, startHrWatch]);

  // ── derived stats ──────────────────────────────────────────────────────────
  // Split from the HR summary on purpose: a live HR sensor notifies at ~1 Hz,
  // far more often than GPS fixes land, so keying one memo on both `points` and
  // `hrSamples` would re-run the O(points) distance/elevation/pace scan below on
  // every heart-rate sample instead of only when the track actually changes.
  // Keyed on `points` alone for the same reason: the UI clock bumps movingSec
  // every second, and only avgPace (one division) actually depends on it.
  const track = useMemo(() => {
    const km = distanceKm(points);
    const elevation = Math.round(elevGainM(points));
    // Current pace over the last window, anchored on the latest fix's time.
    let curPace = 0;
    if (points.length >= 2) {
      const lastT = points[points.length - 1]?.[2];
      if (lastT) {
        const win = points.filter((p): p is StoredTrackPoint => !!p && p[2] >= lastT - CUR_PACE_WINDOW_MS);
        if (win.length >= 2) {
          const d = distanceKm(win);
          const dt = (win[win.length - 1][2] - win[0][2]) / 1000;
          if (d > 0 && dt > 0) curPace = dt / d;
        }
      }
    }
    return { km, elevation, curPace, n: points.filter(Boolean).length };
  }, [points]);

  const gpsStats = useMemo(
    () => ({ ...track, movingSec, avgPace: track.km > 0 ? movingSec / track.km : 0 }),
    [track, movingSec],
  );

  // `hr`/`hrAt` are the latest reading and its epoch ms, taken from the sensor
  // stream (`hrLast`) rather than the recorded samples so they're live before
  // Start and while paused — the two travel together, since the lock-screen
  // notification's native renderer drops an HR reading it can no longer trust by
  // its timestamp. `hrLast` falls back to the last recorded sample for a
  // recovered run, whose samples predate this session's stream. hrAvg/hrMax stay
  // strictly what was recorded, since they're what the run saves; hrAt is kept
  // out of hrSummary because that shape is spread into saved run fields.
  const stats = useMemo(() => {
    const hr = hrSummary(hrSamples);
    const latest = hrLast ?? (hrSamples.length ? hrSamples[hrSamples.length - 1] : null);
    return { ...gpsStats, ...hr, hr: latest?.bpm ?? null, hrAt: latest?.t ?? null };
  }, [gpsStats, hrSamples, hrLast]);

  // Lock-screen live stats (Android): mirror distance/pace/HR into the
  // foreground-service notification. The DURATION is deliberately not pushed —
  // the notification carries an OS-rendered chronometer anchored at
  // now - movingMs, so the clock ticks natively even when this JS is frozen in
  // the background. Distance/pace are the same story: this effect only runs
  // while the app is in the foreground, so each push doubles as the SEED the
  // native service extrapolates from (`content.live`) once the screen goes off.
  // It re-runs off the same renders the bridge callbacks (onPos/onHrSample) and
  // the control handlers trigger — never off a timer — and
  // pushRunNotification's content gate turns the foreground 1s-tick re-runs
  // into no-ops. Do not move this onto the setInterval above: that interval is
  // exactly what stops in the background.
  useEffect(() => {
    // Indoor: the notification is rendered BY the location foreground service,
    // which isn't running without a geo watch — and distance/pace would be
    // meaningless on it anyway. The session lives on the wake lock instead.
    if (!isNative || indoor) return;
    if (state !== "tracking" && state !== "paused") { resetRunNotification(); return; }
    pushRunNotification(buildRunNotificationContent({
      state,
      km: stats.km,
      paceSecPerKm: state === "tracking" ? (stats.curPace || stats.avgPace) : stats.avgPace,
      hr: stats.hr,
      hrAt: stats.hrAt,
      stepText: stepText ?? null,
      // computeMoving reads stateRef, synced by the ref-mirror effect declared
      // above this one (same-commit ordering), so it agrees with `state` here.
      movingMs: computeMoving() * 1000,
      nowMs: Date.now(),
    }));
  }, [state, stats, computeMoving, stepText, indoor]);

  return {
    state, points, stats, error, pending, location, hrSamples, hrStatus,
    // Wall-clock run window, read on demand from an event handler (never during
    // render) — used by handleSave to scope the Health Connect HR fetch.
    runWindow: () => ({ startedAt: runStartRef.current, stoppedAt: runEndRef.current }),
    start, pause, resume, stop, reset, requestPermissions,
    resumePrevious, discardPrevious, finalize,
  };
}
