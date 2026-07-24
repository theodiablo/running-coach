import { useState, useRef, useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Play, Pause, Square, X, Loader, MapPin, HeartPulse, LocateFixed, Search } from "lucide-react";
import { fmt, ymd } from "../utils/format";
import { simplify } from "../utils/geo";
import { saveRoute, queuePendingRoute } from "../routes";
import { useRunTracker } from "../hooks/useRunTracker";
import { useCountdown } from "../hooks/useCountdown";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { useDismissable } from "../hooks/useDismissable";
import { getHrSource } from "../hr/source";
import { requestRunNotificationsOnce } from "../geo/notifications";
import { getPairedDevice } from "../hr/device";
import { hasHealthConnectAuthorization } from "../hr/healthconnect";
import { hasHealthKitAuthorization } from "../healthkit/import";
import { RouteMap } from "../components/RouteMap";
import { ModalOverlay, ConfirmButtons } from "../components/ModalPrimitives";
import { BetaBadge } from "../components/BetaBadge";
import { BgLocationDisclosure } from "./BgLocationDisclosure";
import { RouteFinderSheet } from "./RouteFinderSheet";
import { isNative, isAndroid, isIos } from "../native";
import { BG_LOC_DISCLOSED_KEY, routeSuggestEnabled } from "../constants";
import { track } from "../telemetry";
import type { HrMethod, HrPending, Run, SuggestedRoute } from "../types";

type LiveRunTrackerProps = {
  onFinish: (prefill: Partial<Run> & { hrPending?: HrPending | null }) => void;
  onClose: () => void;
  showToast?: (msg: string, type?: string) => void;
  hrMethod: HrMethod;
  hrOptOut?: boolean;
  onConfigureHr?: () => void;
  onDeclineHr?: () => void;
};

type LocationPreview = { lat: number; lng: number; acc?: number | null };

// `pulseKey` (optional): when it changes, the value re-mounts (via `key`) and
// plays a subtle tick. Used only for the km stat, keyed on the whole-kilometre
// count, so it pulses once per km rather than on every ~1s GPS update.
function Stat({ label, value, pulseKey }: { label: string; value: ReactNode; pulseKey?: number }) {
  return (
    <div className="bg-slate-800 rounded-xl px-3 py-2.5 text-center">
      <p key={pulseKey} className={"text-2xl font-bold text-white leading-tight tabular-nums " + (pulseKey != null ? "animate-tick" : "")}>{value}</p>
      <p className="text-[11px] text-slate-400 uppercase tracking-wide">{label}</p>
    </div>
  );
}

// Large, glove-friendly control button.
function Ctrl({ onClick, color, children, disabled = false }: { onClick: () => void; color: string; children: ReactNode; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={"flex-1 flex items-center justify-center gap-2 py-4 rounded-2xl text-base font-semibold transition-[background-color,transform] active:scale-95 disabled:opacity-50 disabled:active:scale-100 " + color}>
      {children}
    </button>
  );
}

export function LiveRunTracker({ onFinish, onClose, showToast, hrMethod, hrOptOut, onConfigureHr, onDeclineHr }: LiveRunTrackerProps) {
  const pairedHrDevice = getPairedDevice();
  const healthConnectAuthorized = hasHealthConnectAuthorization();
  const healthKitAuthorized = hasHealthKitAuthorization();
  // Local readiness for the *synced* method. getHrSource already nulls an
  // off-platform method (e.g. "healthconnect" synced onto an iPhone), so a
  // platform check here would be redundant — the auth markers are per-device
  // anyway and can only be set on the platform that owns them.
  const hrReady = !isNative
    || (hrMethod || "off") === "off"
    || (hrMethod === "bluetooth" && !!pairedHrDevice)
    || (hrMethod === "healthconnect" && healthConnectAuthorized)
    || (hrMethod === "healthkit" && healthKitAuthorized);
  const effectiveHrMethod = hrReady ? hrMethod : "off";
  const { t } = useTranslation();
  const rt = useRunTracker({ hrMethod: effectiveHrMethod });
  const tracker = rt as Omit<typeof rt, "location"> & { location: LocationPreview | null };
  const { state, points, stats, error, pending, location } = tracker;
  const [busy, setBusy] = useState(false);
  // Live map: `following` mirrors RouteMap's nav-follow (false once the user pans,
  // which surfaces the recenter button); bumping `recenterSignal` snaps back to
  // the current position at the default zoom and re-arms follow.
  const [recenterSignal, setRecenterSignal] = useState(0);
  const [following, setFollowing] = useState(true);
  // "Find a route" loop finder (dormant unless routeSuggestEnabled). The chosen
  // loop becomes a sky dashed guide line under the recorded track — purely
  // visual, the runner follows it by eye. Ephemeral: never saved, gone on close.
  const [showFinder, setShowFinder] = useState(false);
  const [plannedRoute, setPlannedRoute] = useState<SuggestedRoute | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  // A 3-2-1-Go overlay before a fresh run start (never on Resume). It runs AFTER
  // guardedStart's disclosure/HR gates, since guardedStart calls this as its fn.
  // Fire the analytics event at the moment tracking actually begins — after the
  // disclosure / permission / HR-nudge gates and the countdown — never on the
  // button tap and never on Resume, so it counts genuine live-run starts only.
  // No properties (consent-gated in track(); a plain count is all we want).
  const startTracking = () => { track("live_run_started", {}); rt.start(); };
  const countdown = useCountdown(startTracking);
  const startWithCountdown = () => (reducedMotion ? startTracking() : countdown.start(3));
  // Resolve the HR source once per render from the seam (source.js), instead of
  // matching method-id strings all over this file — null off web/"off"/unknown,
  // otherwise carries the `live` flag every branch below dispatches on.
  const hrSrc = getHrSource(effectiveHrMethod);
  // Live HR streams only from a `live` (Bluetooth) source; a post-run source
  // (Health Connect) is fetched in handleSave instead, so no live tile for it.
  const liveHr = !!hrSrc?.live;
  // Nudge to set up / re-authorize a heart-rate source, offered when the user taps
  // Start while HR is off or the synced method is not ready on this device. "Not
  // now" dismisses just this run; "Don't record" sets the opt-out only for the
  // generic off-state prompt. Never blocks Start — see guardedStart/maybeShowHrNudge.
  const [showHrNudge, setShowHrNudge] = useState(false);
  const hrNudge = (() => {
    if (!isNative) return null;
    // Re-authorize nudges only make sense on the platform that owns the synced
    // method — on the other platform the method is effectively "off" but the
    // generic setup nudge below would mislead too, so show nothing for it.
    if (hrMethod === "healthconnect" && isAndroid && !healthConnectAuthorized) return {
      title: t("tracker.hrNudge.authTitle"),
      body: t("tracker.hrNudge.authBody"),
      acceptLabel: t("tracker.hrNudge.authAccept"),
      allowOptOut: false,
    };
    if (hrMethod === "healthkit" && isIos && !healthKitAuthorized) return {
      title: t("tracker.hrNudge.hkAuthTitle"),
      body: t("tracker.hrNudge.hkAuthBody"),
      acceptLabel: t("tracker.hrNudge.authAccept"),
      allowOptOut: false,
    };
    if (hrMethod === "bluetooth" && !pairedHrDevice) return {
      title: t("tracker.hrNudge.pairTitle"),
      body: t("tracker.hrNudge.pairBody"),
      acceptLabel: t("tracker.hrNudge.pairAccept"),
      allowOptOut: false,
    };
    if ((hrMethod || "off") === "off" && !hrOptOut) return {
      title: t("tracker.hrNudge.setupTitle"),
      body: t("tracker.hrNudge.setupBody"),
      acceptLabel: t("tracker.hrNudge.setupAccept"),
      allowOptOut: true,
    };
    return null;
  })();
  const disclosed = () => {
    try { return localStorage.getItem(BG_LOC_DISCLOSED_KEY) === "1"; } catch { return false; }
  };
  const markDisclosed = () => {
    try { localStorage.setItem(BG_LOC_DISCLOSED_KEY, "1"); } catch { /* quota — non-fatal */ }
  };
  // On native, surface the disclosure the moment the tracker opens (not only on
  // Start), so consent is the first thing shown. The flag is set only once the OS
  // grant succeeds (acceptDisclosure), so a denial naturally re-shows the disclosure
  // next time — no need to watch the error text. guardedStart gates Start/Resume too.
  const [showDisclosure, setShowDisclosure] = useState(() => isNative && !disclosed());
  const pendingStartRef = useRef<(() => void) | null>(null); // deferred Start/Resume action, run once consented/nudged
  const pendingHrCheckRef = useRef(false); // whether that deferred action should also offer the HR nudge
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const hasTrack = stats.n > 0;
  const live = state === "tracking" || state === "paused";

  // Returning from a locked screen / app background snaps the live map back to the
  // current position at the default zoom (the requested reset). visibilitychange
  // fires in the native WebView on screen lock/unlock and app foreground, and on
  // web when the tab is refocused.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && (state === "tracking" || state === "paused")) {
        setRecenterSignal(n => n + 1);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [state]);
  // Offer the HR nudge in place of `fn`, deferring it the same way the
  // disclosure does. Returns whether the nudge took over (caller must not also
  // call fn in that case).
  const maybeShowHrNudge = (fn: () => void) => {
    if (hrNudge) {
      pendingStartRef.current = fn;
      setShowHrNudge(true);
      return true;
    }
    return false;
  };
  // Run `fn` — which starts a background watch on native — but gate the FIRST one
  // behind the prominent-disclosure (Play requirement) and, only for a genuine
  // run start (checkHr), the HR setup nudge — never on Resume, so pausing for a
  // traffic light doesn't re-nag. Covers BOTH the idle "Start run" and the paused
  // "Resume" (incl. the crash-recovery resume, which starts a fresh watch), so a
  // background-location request never fires without a prior disclosure. No-op
  // gate on the web / once already disclosed.
  const guardedStart = async (fn: () => void, checkHr = false) => {
    if (isNative && !disclosed()) {
      pendingStartRef.current = fn;
      pendingHrCheckRef.current = checkHr;
      setShowDisclosure(true);
      return;
    }
    // Native: confirm location is actually usable — permission granted AND the
    // device's Location Services switched on — BEFORE entering the recording
    // state, so a run never starts silently with a running clock and a blank map
    // and the user left guessing why. requestPermissions surfaces the OS
    // permission prompt and/or the "turn on location" dialog and, on denial, sets
    // an actionable error (tracker.errors.permissionDeniedNative, which explains
    // both fixes) and returns false — abort rather than start a location-less run.
    // The first-ever run takes the disclosure branch above, which already requests
    // permission in acceptDisclosure, so this guards every subsequent Start/Resume
    // (including after the user revokes access or turns Location off in Settings).
    if (isNative) {
      const granted = await rt.requestPermissions();
      if (!mountedRef.current) return;
      if (!granted) return;
    }
    // Ask once (Android 13+) for notification permission so the recording
    // foreground-service notification is visible — before the watch/service
    // starts. Never blocks: no-op after the first ask or off-Android.
    await requestRunNotificationsOnce();
    if (!mountedRef.current) return;
    if (checkHr && maybeShowHrNudge(fn)) return;
    fn();
  };
  const acceptDisclosure = async () => {
    setShowDisclosure(false);
    const run = pendingStartRef.current;
    const checkHr = pendingHrCheckRef.current;
    pendingStartRef.current = null;
    pendingHrCheckRef.current = false;
    // Ask the OS for location right after consent (native) so the prompt is part of
    // the disclosure flow, not deferred to Start. Mark disclosed only on success, so
    // a denial leaves it unset and the disclosure re-explains next time; the upfront
    // grant also means a later Start won't prompt again.
    const granted = isNative ? await rt.requestPermissions() : true;
    if (!granted || !mountedRef.current) return;
    markDisclosed();
    // Same one-time notification ask as guardedStart, here on the first-ever run
    // (which goes through the disclosure), before the run's foreground service starts.
    await requestRunNotificationsOnce();
    if (!mountedRef.current) return;
    if (checkHr && run && maybeShowHrNudge(run)) return;
    run?.();
  };
  const cancelDisclosure = () => {
    setShowDisclosure(false);
    pendingStartRef.current = null;
    pendingHrCheckRef.current = false;
  };
  // "Not now"/"Don't record" both let the deferred Start/Resume proceed (the
  // nudge never blocks Start); "Set up" hands off to Settings instead.
  const dismissHrNudge = (run: boolean) => {
    setShowHrNudge(false);
    const fn = pendingStartRef.current;
    pendingStartRef.current = null;
    if (run) fn?.();
  };

  const handleClose = () => {
    if ((live || state === "stopped") && hasTrack &&
      !window.confirm(t("tracker.discardConfirm"))) return;
    // Only tear down (which clears the crash-recovery buffer) for an in-progress
    // or just-finished run. Backing out while idle must NOT wipe an unresumed
    // recovery buffer — it should still be offered next time the tracker opens.
    if (live || state === "stopped") rt.reset();
    onClose();
  };

  const handleSave = async () => {
    setBusy(true);
    const simplified = simplify(points, 5);
    const km = +stats.km.toFixed(2);
    // Persist the raw ~1Hz HR stream as a sidecar on the route stats (BLE runs
    // only — post-run HR sources and web runs leave hrSamples empty). Kept raw,
    // not projected onto GPS points, so HR fidelity doesn't depend on how
    // aggressively simplify() thinned the track; RunDetailModal aligns it to
    // points by timestamp at render. Unknown JSONB key → ignored by old clients.
    const statObj = { km, durationSec: stats.movingSec, elevation: stats.elevation, avgPace: Math.round(stats.avgPace),
      ...(rt.hrSamples?.length ? { hrSamples: rt.hrSamples } : {}) };
    const date = ymd(new Date(points.find(Boolean)?.[2] || Date.now()));
    let routeId = null, routeTmp = null;
    try {
      routeId = await saveRoute({ points: simplified, stats: statObj });
    } catch {
      // Offline / save failed — queue the trace so it isn't lost; it relinks on
      // the next load (see flushPendingRoutes in RunningCoach). Don't fail
      // silently: the route is viewable locally but won't be in the cloud yet.
      routeTmp = "rt" + Date.now();
      queuePendingRoute({ tmpId: routeTmp, points: simplified, stats: statObj });
      showToast?.(t("tracker.routeUploadFailed"), "err");
    }
    // Heart rate: a live source (hrSrc.live, e.g. Bluetooth) has already filled
    // stats.hrAvg/hrMax. A post-run source (hrSrc set, not live, e.g. Health
    // Connect) is queried now over the run's time window; if it isn't synced yet,
    // stamp hrPending so RunningCoach relinks on next load. Branching on hrSrc
    // (not a hard-coded method id) means a future post-run source needs no edits
    // here — and hrSrc is already null on web or when the synced method is not
    // ready on this device, so this can't fire without local authorization/pairing.
    let hr = null, hrMax = null, hrPending = null;
    if (stats.hrAvg != null) { hr = stats.hrAvg; hrMax = stats.hrMax; }
    else if (hrSrc && !hrSrc.live) {
      // Explicit run window from the tracker (robust even with no GPS points),
      // falling back to point timestamps for a recovered run missing startedAt.
      const { startedAt, stoppedAt } = rt.runWindow();
      const startMs = startedAt || points.find(Boolean)?.[2] || Date.now();
      let endMs = stoppedAt || Date.now();
      if (!stoppedAt) for (let i = points.length - 1; i >= 0; i--) { const p = points[i]; if (p) { endMs = p[2]; break; } }
      let res = null;
      try { res = await (hrSrc as { fetchRange: (startMs: number, endMs: number) => Promise<{ hrAvg?: number; hrMax?: number }> }).fetchRange(startMs, endMs); } catch { /* unsynced — leave null */ }
      if (res && res.hrAvg) { hr = res.hrAvg; hrMax = res.hrMax; }
      else hrPending = { start: startMs, end: endMs, source: hrSrc.id };
    }
    // Stamp the run's real start instant so a later watch import of the same run
    // (Health Connect) can dedupe by time overlap instead of double-logging it.
    const startedAtMs = rt.runWindow().startedAt || points.find(Boolean)?.[2] || null;
    rt.finalize();
    setBusy(false);
    onFinish({
      date, type: "EASY", km,
      durationSec: stats.movingSec,
      elevation: stats.elevation || undefined,
      source: "gps",
      ...(startedAtMs ? { startedAt: new Date(startedAtMs).toISOString() } : {}),
      ...(routeId ? { routeId } : {}),
      ...(routeTmp ? { routeTmp, routePending: true } : {}),
      ...(hr != null ? { hr, hrMax } : {}),
      // HealthKit markers ride their own field: shipped Android clients clear
      // any hrPending whose source isn't "healthconnect" from the synced blob,
      // which would destroy an iPhone's deferred HR before it could resolve.
      ...(hrPending ? (hrPending.source === "healthkit" ? { hrPendingHk: hrPending } : { hrPending }) : {}),
    });
  };

  // Back/Escape dismissal, innermost first: countdown → HR nudge → the tracker
  // itself (routed through handleClose so an in-progress run gets the discard
  // confirm, never a silent teardown). Each registers only while shown, so the
  // stack order matches what's visually on top. The bg-location disclosure
  // self-registers inside BgLocationDisclosure, so it isn't listed here.
  useDismissable(true, handleClose);
  useDismissable(showHrNudge, () => dismissHrNudge(false));
  useDismissable(countdown.count !== null, countdown.cancel);

  return (
    <div className="fixed inset-0 bg-slate-900 z-50 flex flex-col animate-slide-up">
      <header className="flex items-center justify-between px-4 border-b border-slate-800"
        style={{ height: "calc(44px + var(--safe-top))", paddingTop: "var(--safe-top)" }}>
        <div className="flex items-center gap-1.5">
          {state === "tracking" ? (
            <span className="relative flex h-2.5 w-2.5" aria-hidden>
              <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75 animate-ping" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
            </span>
          ) : state === "paused" ? (
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400" aria-hidden />
          ) : (
            <MapPin size={15} className="text-orange-400" />
          )}
          <span className="text-sm font-semibold">{state === "stopped" ? t("tracker.header.complete") : t("tracker.header.live")}</span>
        </div>
        <button onClick={handleClose} aria-label={t("common.close")}
          className="text-slate-400 hover:text-white p-1.5"><X size={18} /></button>
      </header>

      <div className="flex-1 min-h-0 relative">
        <RouteMap points={points} follow={state === "tracking"} interactive
          recenterSignal={recenterSignal} onFollowingChange={setFollowing}
          guidePoints={plannedRoute?.points}
          location={location} className="h-full w-full" style={{}} />
        {live && !following && (
          <button type="button" onClick={() => setRecenterSignal(n => n + 1)} aria-label={t("tracker.map.recenter")}
            className="absolute bottom-3 right-3 z-[1000] flex items-center justify-center w-11 h-11 rounded-full bg-slate-900/85 text-orange-400 border border-slate-700 shadow-lg active:scale-95 transition-transform">
            <LocateFixed size={20} />
          </button>
        )}
      </div>

      <div className="p-4 space-y-3 border-t border-slate-800" style={{ paddingBottom: "calc(1rem + var(--safe-bottom))" }}>
        {error && <div className="bg-red-500/15 text-red-300 text-sm rounded-xl px-3 py-2">{error}</div>}

        {state === "idle" && pending && (
          <div className="bg-slate-800 rounded-xl p-3 space-y-2 border border-slate-700">
            <p className="text-sm text-slate-200">{t("tracker.resume.title")}
              <span className="text-slate-400"> {t("tracker.resume.pointsSaved", { count: (pending.points || []).filter(Boolean).length })}</span></p>
            <div className="flex gap-2">
              <button onClick={rt.resumePrevious}
                className="flex-1 bg-orange-500 hover:bg-orange-600 text-white py-2 rounded-lg text-sm font-semibold">{t("tracker.resume.resume")}</button>
              <button onClick={rt.discardPrevious}
                className="px-4 bg-slate-700 hover:bg-slate-600 text-slate-200 py-2 rounded-lg text-sm font-semibold">{t("tracker.resume.discard")}</button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-4 gap-2">
          <Stat label={t("tracker.stats.km")} value={stats.km.toFixed(2)} pulseKey={live ? Math.floor(stats.km) : undefined} />
          <Stat label={t("tracker.stats.time")} value={fmt.dur(stats.movingSec) === "--" ? "0:00" : fmt.dur(stats.movingSec)} />
          <Stat label={t("tracker.stats.pace")} value={fmt.pace(state === "tracking" ? stats.curPace : stats.avgPace)} />
          <Stat label={t("tracker.stats.elev")} value={stats.elevation + "m"} />
        </div>

        {liveHr && (
          <div className="bg-slate-800 rounded-xl px-3 py-2 flex items-center justify-center gap-2">
            <HeartPulse size={18} className={stats.hr != null ? "text-red-400" : "text-slate-500"} />
            <span className="text-2xl font-bold text-white tabular-nums leading-none">{stats.hr ?? "--"}</span>
            <span className="text-[11px] text-slate-400 uppercase tracking-wide">{t("tracker.hr.bpm")}</span>
            <BetaBadge />
            {stats.hrAvg != null
              ? <span className="text-[11px] text-slate-500 ml-2">{t("tracker.hr.avgMax", { avg: stats.hrAvg, max: stats.hrMax })}</span>
              : <span className="text-[11px] text-slate-500 ml-2">{t("tracker.hr.connecting")}</span>}
          </div>
        )}

        {hrSrc && !hrSrc.live && (
          <div className="bg-slate-800 rounded-xl px-3 py-2 flex items-center justify-center gap-2 text-slate-300">
            <HeartPulse size={16} className="text-red-400 shrink-0" />
            <BetaBadge />
            <span className="text-xs">{t("tracker.hr.postRun", { store: hrSrc?.id === "healthkit" ? "Apple Health" : "Health Connect" })}</span>
          </div>
        )}

        {state === "idle" && (
          <>
            {location?.acc != null && (
              <p className={"text-[11px] text-center " + (
                location.acc <= 15 ? "text-emerald-400" : location.acc <= 30 ? "text-amber-400" : "text-red-400")}>
                {t(location.acc <= 15 ? "tracker.gps.accuracyGood" : "tracker.gps.accuracyWait", { acc: Math.round(location.acc) })}
              </p>
            )}
            <div className="flex">
              <Ctrl onClick={() => guardedStart(startWithCountdown, true)} color="bg-orange-500 hover:bg-orange-600 text-white">
                <Play size={20} />{t("tracker.controls.start")}
              </Ctrl>
            </div>
            {routeSuggestEnabled && (
              plannedRoute ? (
                <div className="flex items-center gap-2 rounded-xl bg-sky-500/10 border border-sky-500/30 px-3 py-2 text-sm">
                  <Search size={15} className="text-sky-300 shrink-0" />
                  <span className="text-sky-200">{t("routeFinder.card.distance", { km: plannedRoute.km.toFixed(1) })}</span>
                  <button onClick={() => setShowFinder(true)} className="text-slate-300 hover:text-white underline decoration-slate-600">
                    {t("routeFinder.button")}
                  </button>
                  <button onClick={() => setPlannedRoute(null)} aria-label={t("common.close")}
                    className="ml-auto p-1 text-slate-400 hover:text-white"><X size={15} /></button>
                </div>
              ) : (
                <button onClick={() => setShowFinder(true)}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-base font-semibold bg-sky-500/15 border border-sky-500/40 text-sky-200 hover:bg-sky-500/25 active:scale-95 transition-[background-color,transform]">
                  <Search size={18} />{t("routeFinder.button")}
                </button>
              )
            )}
          </>
        )}
        {state === "tracking" && (
          <div className="flex gap-2">
            <Ctrl onClick={rt.pause} color="bg-slate-700 hover:bg-slate-600 text-slate-100"><Pause size={20} />{t("tracker.controls.pause")}</Ctrl>
            <Ctrl onClick={rt.stop} color="bg-red-500 hover:bg-red-600 text-white"><Square size={18} />{t("tracker.controls.finish")}</Ctrl>
          </div>
        )}
        {state === "paused" && (
          <div className="flex gap-2">
            <Ctrl onClick={() => guardedStart(rt.resume)} color="bg-orange-500 hover:bg-orange-600 text-white"><Play size={20} />{t("tracker.controls.resume")}</Ctrl>
            <Ctrl onClick={rt.stop} color="bg-red-500 hover:bg-red-600 text-white"><Square size={18} />{t("tracker.controls.finish")}</Ctrl>
          </div>
        )}
        {state === "stopped" && (
          <div className="flex gap-2">
            <Ctrl onClick={handleClose} color="bg-slate-700 hover:bg-slate-600 text-slate-100" disabled={busy}>{t("tracker.controls.discard")}</Ctrl>
            <Ctrl onClick={handleSave} color="bg-orange-500 hover:bg-orange-600 text-white" disabled={busy}>
              {busy ? <Loader size={18} className="animate-spin" /> : null}{t("tracker.controls.save")}
            </Ctrl>
          </div>
        )}

        {live && !isNative && (
          <p className="text-[11px] text-slate-500 text-center leading-snug">
            {t("tracker.keepScreenOn")}
          </p>
        )}
      </div>

      {showDisclosure && (
        <BgLocationDisclosure onAccept={acceptDisclosure} onCancel={cancelDisclosure} />
      )}

      {/* Nudge to set up a heart-rate source, offered once per Start tap (never on
          Resume/pause cycles) while the location disclosure isn't up — see
          guardedStart/maybeShowHrNudge. Reappears each run until the user sets HR
          up or taps "Don't record heart rate" (persistent opt-out). */}
      {showHrNudge && (
        <ModalOverlay>
          <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-slate-700 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <HeartPulse size={16} className="text-orange-400" />
              <p className="font-semibold text-sm">{hrNudge?.title || t("tracker.hrNudge.setupTitle")}</p>
              <BetaBadge label={t("tracker.hrNudge.newBeta")} />
            </div>
            <p className="text-sm text-slate-300">
              {hrNudge?.body || t("tracker.hrNudge.setupBody")}
            </p>
            <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs leading-snug text-amber-100">
              {t("tracker.hrNudge.betaWarning")}
            </p>
            <ConfirmButtons cancelLabel={t("common.notNow")} acceptLabel={hrNudge?.acceptLabel || t("tracker.hrNudge.setupAccept")}
              onCancel={() => dismissHrNudge(true)}
              onAccept={() => { dismissHrNudge(false); onConfigureHr?.(); }} />
            {hrNudge?.allowOptOut && (
              <button onClick={() => { dismissHrNudge(true); onDeclineHr?.(); }}
                className="w-full text-center text-xs text-slate-500 hover:text-slate-300">
                {t("tracker.hrNudge.optOut")}
              </button>
            )}
          </div>
        </ModalOverlay>
      )}

      {countdown.count !== null && (
        <button type="button" onClick={countdown.cancel} aria-label={t("common.cancel")}
          className="absolute inset-0 z-[1100] flex items-center justify-center bg-slate-900/85">
          <span key={countdown.count} aria-live="assertive"
            className="text-8xl font-extrabold text-orange-400 tabular-nums animate-countdown">
            {countdown.count > 0 ? countdown.count : t("tracker.countdown.go")}
          </span>
        </button>
      )}

      {showFinder && (
        <RouteFinderSheet
          location={location ? { lat: location.lat, lng: location.lng } : null}
          showToast={showToast}
          onSelect={setPlannedRoute}
          onClose={() => setShowFinder(false)} />
      )}
    </div>
  );
}
