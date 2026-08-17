import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Play, Pause, Square, X, Loader, MapPin, HeartPulse, LocateFixed, Search, Lock, Radio, BatteryCharging, Link2, Link2Off, Check } from "lucide-react";
import { fmt, ymd } from "../utils/format";
import { simplify } from "../utils/geo";
import { saveRoute, queuePendingRoute } from "../routes";
import { canPublishNow, endLiveRun, publishLiveRun, resetLivePublisher, sweepOwnLiveRun } from "../live/publisher";
import { mintShareToken, readShareToken, storeShareToken, watchUrl } from "../live/shareLink";
import { mintPublishToken, readPublishToken, storePublishToken } from "../live/publishToken";
import { enableLiveUpload, disableLiveUpload } from "../geo/liveUpload";
import { bestEffortsFromTrack } from "../utils/bestEfforts";
import { useRunTracker } from "../hooks/useRunTracker";
import { markRender } from "../diag/frameHeartbeat";
import { useGuidedWorkout } from "../hooks/useGuidedWorkout";
import { useCountdown } from "../hooks/useCountdown";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { useDismissable } from "../hooks/useDismissable";
import { getHrSource } from "../hr/source";
import { readHrJournal } from "../hr/hrJournal";
import { HR_MIN_COVERAGE, hrCoverage, hrSummary, isHrStale, mergeHrSamples } from "../utils/hr";
import { requestRunNotificationsOnce } from "../geo/notifications";
import { markBatteryNudgeDismissed, openBatteryOptimizationSettings, shouldNudgeBatteryOptimization } from "../geo/battery";
import { getPairedDevice } from "../hr/device";
import { hasHealthConnectAuthorization } from "../hr/healthconnect";
import { hasHealthKitAuthorization } from "../healthkit/import";
import { RouteMap } from "../components/RouteMap";
import { GuidedWorkoutPanel } from "../components/GuidedWorkoutPanel";
import { ModalOverlay, ConfirmButtons } from "../components/ModalPrimitives";
import { BetaBadge } from "../components/BetaBadge";
import { BgLocationDisclosure } from "./BgLocationDisclosure";
import { RouteFinderSheet } from "./RouteFinderSheet";
import { PremiumTeaserSheet } from "./PremiumTeaserSheet";
import { isNative, isAndroid, isIos } from "../native";
import { BG_LOC_DISCLOSED_KEY, LIVE_SHARE_KEY, routeSuggestEnabled } from "../constants";
import { canShowPremiumTeaser, isPremiumActive } from "../premium";
import { primeCues } from "../cues";
import { track } from "../telemetry";
import { hrNudgeFor } from "../utils/hrNudge";
import type { HrMethod, HrPending, PlanSession, Run, SuggestedRoute } from "../types";

type LiveRunTrackerProps = {
  onFinish: (prefill: Partial<Run> & { hrPending?: HrPending | null }) => void;
  onClose: () => void;
  showToast?: (msg: string, type?: string) => void;
  hrMethod: HrMethod;
  hrOptOut?: boolean;
  onConfigureHr?: () => void;
  onDeclineHr?: () => void;
  // When set (e.g. opened from a plan session), auto-open the route finder with
  // this distance pre-filled.
  initialFindKm?: number;
  // The plan session the tracker was opened from — a guidable one (tempo /
  // intervals / run-walk) turns on the guided-workout mode (premium).
  session?: PlanSession | null;
  // "Find a route" is premium-only. UI affordance only — the route-suggest edge
  // function is the gate that matters. onRefreshPremium resolves with the fresh
  // entitlement so the tap can act on it immediately.
  isPremium?: boolean;
  onRefreshPremium?: () => Promise<string | null>;
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

export function LiveRunTracker({ onFinish, onClose, showToast, hrMethod, hrOptOut, onConfigureHr, onDeclineHr, initialFindKm, session, isPremium = false, onRefreshPremium }: LiveRunTrackerProps) {
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
  // Guided-workout step line for the lock-screen surfaces. The guide hook
  // needs the tracker's state/stats, so the value feeds BACK into
  // useRunTracker as state, reconciled during render (the derived-state
  // pattern) — the re-render settles before effects run, so the notification
  // effect always pushes the settled value.
  const [stepText, setStepText] = useState<string | null>(null);
  const rt = useRunTracker({ hrMethod: effectiveHrMethod, stepText });
  const tracker = rt as Omit<typeof rt, "location"> & { location: LocationPreview | null };
  const { state, points, stats, error, pending, location } = tracker;
  // Diagnostics: stamps every commit of this component, so a report can say
  // whether React is still rendering while the numbers on screen are frozen
  // (see src/diag/frameHeartbeat.ts). Cheap and side-effect-free.
  markRender();
  const [busy, setBusy] = useState(false);
  // ── Guided workout (premium) ─────────────────────────────────────────────
  // The sign-in entitlement read can be stale (offline, or predating a grant),
  // and guidance has no tap to re-check on — it just appears. So with a
  // guidable session on deck and a free-looking user, re-read once and decide
  // on that read; a confirmed grant flips guidance on mid-screen.
  const [premiumFresh, setPremiumFresh] = useState(false);
  const premiumForGuide = isPremium || premiumFresh;
  const guide = useGuidedWorkout(session, premiumForGuide, state, stats);
  const premiumRecheckedRef = useRef(false);
  useEffect(() => {
    if (!guide.guidable || isPremium || premiumRecheckedRef.current) return;
    premiumRecheckedRef.current = true;
    let cancelled = false;
    onRefreshPremium?.().then(until => {
      if (!cancelled && isPremiumActive(until)) setPremiumFresh(true);
    });
    return () => { cancelled = true; };
  }, [guide.guidable, isPremium, onRefreshPremium]);
  const liveStepText =
    guide.display && (state === "tracking" || state === "paused") ? guide.display.stepText : null;
  if (liveStepText !== stepText) setStepText(liveStepText);
  // Live map: `following` mirrors RouteMap's nav-follow (false once the user pans,
  // which surfaces the recenter button); bumping `recenterSignal` snaps back to
  // the current position at the default zoom and re-arms follow.
  const [recenterSignal, setRecenterSignal] = useState(0);
  const [following, setFollowing] = useState(true);
  // "Find a route" loop finder (needs the map capability AND premium). The
  // chosen loop becomes a sky dashed guide line under the recorded track —
  // purely visual, the runner follows it by eye. Ephemeral: never saved, gone
  // on close.
  const routeFinderReady = routeSuggestEnabled && isPremium;
  // While `canShowPremiumTeaser` is false a free user has no entry point to tap
  // and can't be sent here from a plan session either, so both of these stay
  // false for them. The teaser wiring is kept for the entitlement re-read below
  // and for the unveil (see src/premium.ts).
  const [showFinder, setShowFinder] = useState(routeFinderReady && !!initialFindKm);
  // Which premium feature slug the teaser is standing in for (null = closed);
  // more than one entry point on this screen now routes here.
  const [premiumTeaser, setPremiumTeaser] = useState<string | null>(
    routeSuggestEnabled && !isPremium && canShowPremiumTeaser && !!initialFindKm ? "routeFinder" : null);
  const [plannedRoute, setPlannedRoute] = useState<SuggestedRoute | null>(null);
  // Tapping the entry point is the one moment a stale entitlement is about to
  // decide something, so re-read it and DECIDE ON THAT READ. The sign-in fetch
  // runs once and may have failed offline or predated a grant, so a premium user
  // can legitimately look free here — sending them to the "not available yet"
  // sheet (and logging a premium_teaser_shown that never happened) would be
  // wrong on both counts. The reverse also lands here: a grant that lapsed
  // mid-session gets the teaser rather than a button that does nothing.
  const [checkingPremium, setCheckingPremium] = useState(false);
  const openFinderOrTeaser = async () => {
    if (routeFinderReady) { setShowFinder(true); return; }
    if (checkingPremium) return;
    setCheckingPremium(true);
    const until = await onRefreshPremium?.();
    setCheckingPremium(false);
    if (routeSuggestEnabled && isPremiumActive(until)) setShowFinder(true);
    else setPremiumTeaser("routeFinder");
  };
  // ── Live sharing (premium) ───────────────────────────────────────────────
  // Broadcasts the run to the user's OWN other signed-in sessions. The choice is
  // per-device (see LIVE_SHARE_KEY): whether this phone goes on the air is not
  // something another device should decide for it.
  const [shareLive, setShareLive] = useState(() => {
    try { return localStorage.getItem(LIVE_SHARE_KEY) === "1"; } catch { return false; }
  });
  const [checkingSharePremium, setCheckingSharePremium] = useState(false);
  // Entry point present? Same gate as every other premium affordance, never
  // `isPremium` alone (see src/premium.ts).
  const shareAvailable = isPremium || canShowPremiumTeaser;
  // What actually governs publishing and the on-air indicator. The stored choice
  // only counts while the toggle that sets it is on screen: an entitlement that
  // lapsed since the last run would otherwise leave a permanent "Share live · On"
  // badge, with no control to clear it and nothing being shared behind it.
  const sharing = shareLive && shareAvailable;
  // Set the moment the broadcast is torn down, so a re-render after the row has
  // been deleted can't resurrect it with one last "ended" write.
  const shareEndedRef = useRef(false);
  const sweptRef = useRef(false);
  const armShare = (on: boolean) => {
    setShareLive(on);
    try { localStorage.setItem(LIVE_SHARE_KEY, on ? "1" : "0"); } catch { /* quota — non-fatal */ }
    if (on) track("live_share_enabled", {});
  };
  // Same re-read-and-decide as the route finder: the sign-in entitlement fetch
  // may have failed offline or predated a grant, so don't let a stale read send
  // a genuine premium user to the "not available" sheet.
  const toggleShareLive = async () => {
    if (shareLive) { armShare(false); return; }
    if (isPremium) { armShare(true); return; }
    if (checkingSharePremium) return;
    setCheckingSharePremium(true);
    const until = await onRefreshPremium?.();
    setCheckingSharePremium(false);
    if (isPremiumActive(until)) armShare(true);
    else setPremiumTeaser("liveShare");
  };
  const endShare = () => {
    if (shareEndedRef.current) return;
    shareEndedRef.current = true;
    // Disarm the native uploader FIRST and directly (never via the notification
    // queue): endLiveRun is about to delete the row, and a native batch landing
    // after that is a no-op server-side, but there is no reason to send it.
    disarmLiveUpload();
    void endLiveRun();
  };
  // ── Native screen-off uploads (Android) ─────────────────────────────────
  // One writer at a time: the native uploader runs ONLY while the WebView is
  // hidden (it is about to be frozen); the moment JS is back it is disarmed and
  // the JS publisher's next full-trace write re-bases everything. The publish
  // token is the run's write capability — minted per run in startTracking,
  // adopted from storage only alongside a recoverable run (like the share
  // token, and for the same reason).
  const publishTokenRef = useRef<string | null>(pending ? readPublishToken() : null);
  const uploaderArmedRef = useRef(false);
  const disarmLiveUpload = useCallback(() => {
    if (!uploaderArmedRef.current) return;
    uploaderArmedRef.current = false;
    disableLiveUpload();
  }, []);
  // ── Public share link ────────────────────────────────────────────────────
  // A link anyone can open — signed in or not, account or no account. The token
  // IS the authorization (src/live/shareLink.ts), so there is no viewer list to
  // manage and nothing to revoke afterwards: the link dies with the run.
  //
  // Adopted from storage ONLY when there is a run to recover. That is the one
  // situation where a link already sent out must keep working — the app was
  // killed mid-run and the recovered run republishes under the same token. A
  // tracker opening fresh starts with no link, so a token left behind by a run
  // that never started can never be inherited by an unrelated later run.
  const [shareToken, setShareToken] = useState<string | null>(() => (pending ? readShareToken() : null));
  const [linkCopied, setLinkCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current); }, []);
  const flashCopied = () => {
    setLinkCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setLinkCopied(false), 2500);
  };
  // Mints on first use, then re-shares the same token — a run has ONE link, so
  // tapping "Send link" twice doesn't strand whoever got the first one. Only
  // reachable while the broadcast is already on (see shareLinkRow), which is
  // what keeps the premium re-read in toggleShareLive alone.
  const shareTheLink = async () => {
    let token = shareToken;
    if (!token) {
      token = mintShareToken();
      storeShareToken(token);
      setShareToken(token);
      track("live_share_link_created", {});
    }
    const url = watchUrl(token);
    // Progressive enhancement, no native plugin: the OS share sheet where the
    // WebView offers one, the clipboard otherwise, and the raw URL as a last
    // resort so the runner is never left with a link they can't get at.
    try {
      if (navigator.share) { await navigator.share({ url }); return; }
    } catch (err) {
      // Dismissing the sheet is a decision, not a failure — copying anyway
      // would answer a "no" with a "done". Anything else (the WebView refusing
      // the call at all) falls through to the clipboard.
      if (err instanceof Error && err.name === "AbortError") return;
    }
    try {
      await navigator.clipboard.writeText(url);
      flashCopied();
    } catch {
      showToast?.(url);
    }
  };
  // Takes the run off the public link WITHOUT ending the broadcast: the runner's
  // own sessions keep following it. The next publish writes the null through
  // (it bypasses the throttle), and the page the link points at goes back to
  // saying nothing is live — the same thing it says for a token that never
  // existed, so a viewer learns nothing from the change.
  const revokeLink = () => {
    storeShareToken(null);
    setShareToken(null);
    setLinkCopied(false);
    track("live_share_link_revoked", {});
  };
  // Throwing away a recovered run takes it off the air with it. The boot sweep
  // deliberately spared the row while the buffer existed — this is the moment
  // that decision is resolved, and nothing else will resolve it.
  const discardRecovered = () => {
    track("live_run_recovery_discarded", {});
    sweptRef.current = true;
    void sweepOwnLiveRun();
    rt.discardPrevious();
  };
  const resumeRecovered = () => {
    track("live_run_recovery_resumed", {});
    rt.resumePrevious();
  };
  // Pairs with live_run_started as a start→finish funnel; km/duration only
  // (never location or free text — see docs/telemetry.md).
  const finishRun = () => {
    track("live_run_stopped", { km: +stats.km.toFixed(2), durationSec: stats.movingSec });
    rt.stop();
  };
  // One-time Android nudge: with battery optimization active the OS can kill the
  // app mid-run — the #1 cause of a lost recording. Shown as an idle-screen card
  // (never a Start gate); either button dismisses it for good.
  const [showBatteryNudge, setShowBatteryNudge] = useState(false);
  useEffect(() => {
    let cancelled = false;
    shouldNudgeBatteryOptimization().then(show => { if (!cancelled && show) setShowBatteryNudge(true); });
    return () => { cancelled = true; };
  }, []);
  const dismissBatteryNudge = (openSettings: boolean) => {
    markBatteryNudgeDismissed();
    setShowBatteryNudge(false);
    if (openSettings) openBatteryOptimizationSettings();
  };
  const reducedMotion = usePrefersReducedMotion();
  // A 3-2-1-Go overlay before a fresh run start (never on Resume). It runs AFTER
  // guardedStart's disclosure/HR gates, since guardedStart calls this as its fn.
  // Fire the analytics event at the moment tracking actually begins — after the
  // disclosure / permission / HR-nudge gates and the countdown — never on the
  // button tap and never on Resume, so it counts genuine live-run starts only.
  // No properties (consent-gated in track(); a plain count is all we want).
  const startTracking = () => {
    track("live_run_started", {});
    // Unlock cue audio while we're still in a user gesture (autoplay policy /
    // the iOS audio session). No-op when nothing will ever cue.
    if (guide.active) primeCues();
    // Fresh broadcast state so this run stamps its own started_at rather than
    // inheriting a previous one, and re-arms after an earlier run was ended.
    resetLivePublisher();
    shareEndedRef.current = false;
    // A fresh run mints its own write capability — NEVER inherited from a
    // previous run in the same mount, or a retained native batch could append
    // the last run's positions to this one's broadcast.
    const publishToken = mintPublishToken();
    storePublishToken(publishToken);
    publishTokenRef.current = publishToken;
    rt.start();
  };
  const countdown = useCountdown(startTracking);
  const startWithCountdown = () => (reducedMotion ? startTracking() : countdown.start(3));
  // Resolve the HR source once per render from the seam (source.js), instead of
  // matching method-id strings all over this file — null off web/"off"/unknown,
  // otherwise carries the `live` flag every branch below dispatches on.
  const hrSrc = getHrSource(effectiveHrMethod);
  // Live HR streams only from a `live` (Bluetooth) source; a post-run source
  // (Health Connect) is fetched in handleSave instead, so no live tile for it.
  const liveHr = !!hrSrc?.live;
  // A strap that dies leaves its last bpm on screen, and hrAvg stays non-null
  // for the rest of the run, so the status line would read "avg · max" forever
  // and never surface hrStatus again. Read at render time: accepted fixes and
  // the 1s clock tick both re-render, so it refreshes without its own timer.
  const hrStale = liveHr && isHrStale(stats.hrAt);
  // Nudge to set up / re-authorize a heart-rate source, offered when the user taps
  // Start while HR is off or the synced method is not ready on this device. "Not
  // now" dismisses just this run; "Don't record" sets the opt-out only for the
  // generic off-state prompt. Never blocks Start — see guardedStart/maybeShowHrNudge.
  const [showHrNudge, setShowHrNudge] = useState(false);
  // Copy for the nudge the pure rules picked; see utils/hrNudge.ts for why the
  // other platform's synced method yields none.
  const hrNudgeChoice = hrNudgeFor({
    isNative, isAndroid, isIos, hrMethod,
    healthConnectAuthorized, healthKitAuthorized,
    pairedHrDevice: !!pairedHrDevice, hrOptOut: !!hrOptOut,
  });
  const HR_NUDGE_COPY = {
    auth:   { title: t("tracker.hrNudge.authTitle"),   body: t("tracker.hrNudge.authBody"),   acceptLabel: t("tracker.hrNudge.authAccept") },
    hkAuth: { title: t("tracker.hrNudge.hkAuthTitle"), body: t("tracker.hrNudge.hkAuthBody"), acceptLabel: t("tracker.hrNudge.authAccept") },
    pair:   { title: t("tracker.hrNudge.pairTitle"),   body: t("tracker.hrNudge.pairBody"),   acceptLabel: t("tracker.hrNudge.pairAccept") },
    setup:  { title: t("tracker.hrNudge.setupTitle"),  body: t("tracker.hrNudge.setupBody"),  acceptLabel: t("tracker.hrNudge.setupAccept") },
  };
  const hrNudge = hrNudgeChoice
    ? { ...HR_NUDGE_COPY[hrNudgeChoice.id], allowOptOut: hrNudgeChoice.allowOptOut }
    : null;
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

  // Mirror of the lock-screen notification effect in useRunTracker, and driven by
  // the same renders: an accepted GPS fix changes `points`, which re-runs this.
  // Never a timer — those are throttled in the background, which is exactly when
  // a run is being recorded with the screen off. canPublishNow is checked BEFORE
  // simplify() so the ~1/s foreground clock ticks don't re-simplify a long trace
  // only to throw it away.
  useEffect(() => {
    if (!sharing || shareEndedRef.current) return;
    const status = state === "tracking" ? "live" : state === "paused" ? "paused" : state === "stopped" ? "ended" : null;
    if (!status) return;
    if (!canPublishNow(status, shareToken)) return;
    void publishLiveRun({
      status,
      points: simplify(points, 5),
      stats: { km: +stats.km.toFixed(2), durationSec: stats.movingSec, avgPace: Math.round(stats.avgPace), curPace: Math.round(stats.curPace) },
      startedAt: rt.runWindow().startedAt,
      shareToken,
      publishToken: publishTokenRef.current,
      // The token was taken (see writeRow): the run is on the air but the link
      // isn't. Say so rather than leave a "Link shared" row over a page that
      // will never show anything.
      onShareTokenRejected: () => { setShareToken(null); showToast?.(t("liveShare.link.rejected"), "err"); },
      // Astronomically unlikely, but a distinct branch: the publisher re-minted
      // after a collision, and a hidden-armed uploader must follow the new key.
      onPublishTokenChanged: (token) => {
        publishTokenRef.current = token;
        if (uploaderArmedRef.current) enableLiveUpload(token);
      },
    });
    // `stats` is in the deps because the moving clock (and HR) can advance
    // without `points` changing — e.g. a paused runner resuming.
  }, [sharing, state, points, stats, rt, shareToken, showToast, t]);

  // The single-writer handoff. Arm the native uploader when the page goes
  // hidden mid-broadcast (visibilitychange fires before Android freezes the
  // WebView — the same window the recovery buffer's persist rides), disarm the
  // moment it is visible again so the JS publisher's next full-trace write
  // re-bases everything. Pause/stop/toggle-off re-run this via deps and disarm
  // too — a paused run must not keep appending from the service. Never armed
  // without a token: a pre-token recovered run simply degrades to v2 behaviour.
  useEffect(() => {
    const sync = () => {
      const shouldArm = document.visibilityState === "hidden" &&
        sharing && state === "tracking" && !shareEndedRef.current && !!publishTokenRef.current;
      if (shouldArm && !uploaderArmedRef.current) {
        uploaderArmedRef.current = true;
        enableLiveUpload(publishTokenRef.current as string);
      } else if (!shouldArm) {
        disarmLiveUpload();
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      // Unmount (header go-Home, dismissAll): JS is demonstrably running, so
      // the frozen-WebView writer has no business staying armed.
      disarmLiveUpload();
    };
  }, [sharing, state, disarmLiveUpload]);

  // Recording with sharing OFF ends any broadcast this device left behind — a
  // killed app, then a resume. The boot sweep skipped it (the recovery buffer was
  // still there) and nothing will publish over it, so this is its last chance to
  // come down before the 6h window expires.
  useEffect(() => {
    if (sharing || sweptRef.current || state !== "tracking") return;
    sweptRef.current = true;
    void sweepOwnLiveRun();
  }, [sharing, state]);

  // In-DOM confirm, never window.confirm (see CLAUDE.md): the Android back
  // gesture routes here, and a native dialog raised as the activity backgrounds
  // never answers, freezing the recorder with it.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const discardRun = () => {
    setConfirmDiscard(false);
    // Discarding takes the run off the air too — the trace is being thrown away,
    // so leaving a row behind would show a watcher a run that no longer exists.
    if (live || state === "stopped") endShare();
    // Only tear down (which clears the crash-recovery buffer) for an in-progress
    // or just-finished run. Backing out while idle must NOT wipe an unresumed
    // recovery buffer — it should still be offered next time the tracker opens.
    if (live || state === "stopped") rt.reset();
    onClose();
  };
  const handleClose = () => {
    if ((live || state === "stopped") && hasTrack) { setConfirmDiscard(true); return; }
    discardRun();
  };

  const handleSave = async () => {
    setBusy(true);
    // Off the air first, and deliberately not awaited: the run is over either
    // way, and a failed delete must never stand between the runner and a saved
    // run (the boot sweep clears an orphan row).
    endShare();
    const simplified = simplify(points, 5);
    const km = +stats.km.toFixed(2);
    // Fold the native HR journal into the live stream: on Android the WebView is
    // frozen whenever the app is backgrounded, so hrSamples only ever holds the
    // beats JS was awake for. The journal is empty off Android and on an
    // unpatched shell, leaving the live stream as the whole story.
    //
    // Read it ONLY for a live source — the same condition that armed it. A
    // post-run source (Health Connect) never journals, so anything on disk would
    // belong to some earlier BLE run; merging it would both invent this run's HR
    // and, by producing an average, skip the store fetch below entirely.
    const hrSamples = mergeHrSamples(rt.hrSamples, hrSrc?.live ? await readHrJournal() : []);
    const hrStats = hrSummary(hrSamples);
    const coverage = hrCoverage(hrSamples, stats.movingSec);
    // Persist the raw ~1Hz HR stream as a sidecar on the route stats (BLE runs
    // only — post-run HR sources and web runs leave hrSamples empty). Kept raw,
    // not projected onto GPS points, so HR fidelity doesn't depend on how
    // aggressively simplify() thinned the track; RunDetailModal aligns it to
    // points by timestamp at render. Unknown JSONB key → ignored by old clients.
    const statObj = { km, durationSec: stats.movingSec, elevation: stats.elevation, avgPace: Math.round(stats.avgPace),
      ...(hrSamples.length ? { hrSamples } : {}) };
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
    if (hrStats.hrAvg != null) {
      // Only claim a run-level average when the stream covers enough of the run.
      // A dropped link leaves the mean of whatever fragment survived — a cooldown
      // walk's 85bpm stamped on a 70-minute session — and that number goes on to
      // feed the coach, the HR zones and race predictions. Below the threshold
      // the samples are still stored (the detail chart draws them) and
      // hrCoverage records how much of the run was measured.
      if (coverage >= HR_MIN_COVERAGE) { hr = hrStats.hrAvg; hrMax = hrStats.hrMax; }
      else showToast?.(t("tracker.hr.partial", { pct: Math.round(coverage * 100) }), "err");
    }
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
    // Fastest 1K/5K/10K/half/marathon inside the trace, measured once here off
    // the SAME simplified points that get stored, so the run detail view and any
    // later comparison read identical numbers. Cheap (a two-pointer sweep) and
    // local — the post-run PB check never refetches a trace or calls the server.
    const bestEfforts = bestEffortsFromTrack(simplified);
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
      // Always stamped, even when empty ("measured, covers no standard
      // distance") — that's what keeps the one-time backfill off this run.
      bestEfforts,
      ...(startedAtMs ? { startedAt: new Date(startedAtMs).toISOString() } : {}),
      ...(routeId ? { routeId } : {}),
      ...(routeTmp ? { routeTmp, routePending: true } : {}),
      ...(hr != null ? { hr, hrMax } : {}),
      // How much of the run the sensor actually measured, so no surface has to
      // guess whether a stored HR series is the whole run or a fragment.
      ...(hrSamples.length ? { hrCoverage: +coverage.toFixed(2) } : {}),
      // HealthKit markers ride their own field: shipped Android clients clear
      // any hrPending whose source isn't "healthconnect" from the synced blob,
      // which would destroy an iPhone's deferred HR before it could resolve.
      ...(hrPending ? (hrPending.source === "healthkit" ? { hrPendingHk: hrPending } : { hrPending }) : {}),
    });
  };

  // Back/Escape dismissal, innermost first: countdown → HR nudge → discard
  // confirm → the tracker itself (routed through handleClose so an in-progress
  // run raises the discard confirm, never a silent teardown). Each registers
  // only while shown, so the stack order matches what's visually on top. The
  // bg-location disclosure self-registers inside BgLocationDisclosure, so it
  // isn't listed here.
  useDismissable(true, handleClose);
  useDismissable(confirmDiscard, () => setConfirmDiscard(false));
  useDismissable(showHrNudge, () => dismissHrNudge(false));
  useDismissable(countdown.count !== null, countdown.cancel);

  // The public-link control, rendered both before a run and during one (a
  // runner who forgot to send the link shouldn't have to stop to fix that).
  // Only offered once the broadcast itself is on: minting a link over a run
  // that publishes nothing would hand someone a page that never fills in, and
  // it keeps the premium re-read in exactly one place (toggleShareLive).
  const shareLinkRow = !sharing ? null : shareToken ? (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 rounded-xl bg-sky-500/10 border border-sky-500/30 px-3 py-2 text-sm">
        <Link2 size={15} className="text-sky-300 shrink-0" />
        <span className="flex-1 text-left text-sky-200">{t("liveShare.link.active")}</span>
        <button onClick={shareTheLink}
          className="flex items-center gap-1 text-slate-300 hover:text-white underline decoration-slate-600">
          {linkCopied ? <Check size={14} className="text-emerald-400" /> : null}
          {t(linkCopied ? "liveShare.link.copied" : "liveShare.link.share")}
        </button>
        <button onClick={revokeLink} aria-label={t("liveShare.link.stop")}
          className="p-1 text-slate-400 hover:text-white"><Link2Off size={15} /></button>
      </div>
      <p className="text-[11px] text-slate-500 leading-snug px-1">{t("liveShare.link.hint")}</p>
    </div>
  ) : (
    <button onClick={shareTheLink}
      className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 active:scale-95 transition-[background-color,transform]">
      <Link2 size={16} className="text-sky-300" />{t("liveShare.link.create")}
    </button>
  );

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
            {(pending.startedAt || pending.savedAt) ? (
              <p className="text-xs text-slate-400">
                {t("tracker.resume.from", { date: fmt.sht(ymd(new Date(pending.startedAt || pending.savedAt))) })}
              </p>
            ) : null}
            <div className="flex gap-2">
              <button onClick={resumeRecovered}
                className="flex-1 bg-orange-500 hover:bg-orange-600 text-white py-2 rounded-lg text-sm font-semibold">{t("tracker.resume.resume")}</button>
              <button onClick={discardRecovered}
                className="px-4 bg-slate-700 hover:bg-slate-600 text-slate-200 py-2 rounded-lg text-sm font-semibold">{t("tracker.resume.discard")}</button>
            </div>
          </div>
        )}

        {guide.active && guide.display && state !== "stopped" && (
          <GuidedWorkoutPanel display={guide.display} muted={guide.muted}
            onToggleMute={guide.toggleMute} live={state === "tracking"} />
        )}
        {/* Free user, guidable session: locked hint → teaser. Gated on
            canShowPremiumTeaser like every premium affordance, so it stays
            invisible until the tier unveils. */}
        {guide.guidable && !premiumForGuide && canShowPremiumTeaser && state === "idle" && (
          <button onClick={() => setPremiumTeaser("guidedWorkout")}
            className="w-full flex items-center gap-2.5 py-3 px-3 rounded-xl text-sm font-semibold border bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700 active:scale-95 transition-[background-color,transform]">
            <Lock size={16} className="text-slate-300 shrink-0" />
            <span className="flex-1 text-left">{t("tracker.guided.title")}</span>
            <span className="text-[11px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 bg-orange-500/20 border border-orange-500/40 text-orange-200">
              {t("premium.badge")}
            </span>
          </button>
        )}

        <div className="grid grid-cols-4 gap-2">
          <Stat label={t("tracker.stats.km")} value={stats.km.toFixed(2)} pulseKey={live ? Math.floor(stats.km) : undefined} />
          <Stat label={t("tracker.stats.time")} value={fmt.dur(stats.movingSec) === "--" ? "0:00" : fmt.dur(stats.movingSec)} />
          <Stat label={t("tracker.stats.pace")} value={fmt.pace(state === "tracking" ? stats.curPace : stats.avgPace)} />
          <Stat label={t("tracker.stats.elev")} value={stats.elevation + "m"} />
        </div>

        {liveHr && (
          <div className="bg-slate-800 rounded-xl px-3 py-2 flex items-center justify-center gap-2">
            <HeartPulse size={18} className={stats.hr != null && !hrStale ? "text-red-400" : "text-slate-500"} />
            <span className={"text-2xl font-bold tabular-nums leading-none "
              + (hrStale ? "text-slate-500" : "text-white")}>{stats.hr ?? "--"}</span>
            <span className="text-[11px] text-slate-400 uppercase tracking-wide">{t("tracker.hr.bpm")}</span>
            <BetaBadge />
            {/* avg/max only once the run has recorded samples; before that the
                strap is either already reading (idle preview), still connecting,
                or reported unreachable by the source (kept retrying). A stale
                reading outranks all of it — avg/max is pinned on for the rest of
                the run otherwise, leaving nothing to say the strap stopped. */}
            <span className="text-[11px] text-slate-500 ml-2">
              {hrStale ? (rt.hrStatus === "unreachable" ? t("tracker.hr.cantReach") : t("tracker.hr.reconnecting"))
                : stats.hrAvg != null ? t("tracker.hr.avgMax", { avg: stats.hrAvg, max: stats.hrMax })
                : stats.hr != null ? t("tracker.hr.connected")
                : rt.hrStatus === "unreachable" ? t("tracker.hr.cantReach")
                : t("tracker.hr.connecting")}
            </span>
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
            {showBatteryNudge && (
              <div className="bg-slate-800 rounded-xl p-3 space-y-2 border border-amber-500/30">
                <div className="flex items-center gap-2">
                  <BatteryCharging size={16} className="text-amber-400 shrink-0" />
                  <p className="text-sm font-semibold text-slate-200">{t("tracker.batteryNudge.title")}</p>
                </div>
                <p className="text-xs text-slate-400 leading-snug">{t("tracker.batteryNudge.body")}</p>
                <div className="flex gap-2">
                  <button onClick={() => dismissBatteryNudge(true)}
                    className="flex-1 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-100 py-2 rounded-lg text-sm font-semibold">{t("tracker.batteryNudge.open")}</button>
                  <button onClick={() => dismissBatteryNudge(false)}
                    className="px-4 bg-slate-700 hover:bg-slate-600 text-slate-200 py-2 rounded-lg text-sm font-semibold">{t("tracker.batteryNudge.dismiss")}</button>
                </div>
              </div>
            )}
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
            {/* Live sharing. Gated on `isPremium || canShowPremiumTeaser` (never
                isPremium alone) so the whole tier still reveals by flipping that
                one flag — while it is false a free user sees no entry point. */}
            {shareAvailable && (
              <div className="space-y-1.5">
                <button onClick={toggleShareLive} disabled={checkingSharePremium} aria-pressed={shareLive}
                  className={"w-full flex items-center gap-2.5 py-3 px-3 rounded-xl text-sm font-semibold border transition-[background-color,transform] active:scale-95 disabled:opacity-60 "
                    + (shareLive
                      ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-200"
                      : "bg-slate-800 border-slate-700 text-slate-200")}>
                  {checkingSharePremium
                    ? <Loader size={16} className="animate-spin shrink-0" />
                    : isPremium ? <Radio size={16} className={shareLive ? "text-emerald-300 shrink-0" : "text-slate-400 shrink-0"} />
                    : <Lock size={16} className="text-slate-300 shrink-0" />}
                  <span className="flex-1 text-left">{t("liveShare.toggle.label")}</span>
                  {!isPremium && (
                    <span className="text-[11px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 bg-orange-500/20 border border-orange-500/40 text-orange-200">
                      {t("premium.badge")}
                    </span>
                  )}
                  <span className={"text-[11px] uppercase tracking-wide " + (shareLive ? "text-emerald-300" : "text-slate-500")}>
                    {t(shareLive ? "liveShare.toggle.on" : "liveShare.toggle.off")}
                  </span>
                </button>
                {shareLive && (
                  <p className="text-[11px] text-slate-500 leading-snug px-1">{t("liveShare.toggle.hint")}</p>
                )}
                {shareLinkRow}
              </div>
            )}
            {routeSuggestEnabled && (isPremium || canShowPremiumTeaser) && (
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
                <button onClick={openFinderOrTeaser} disabled={checkingPremium}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-base font-semibold bg-sky-500/15 border border-sky-500/40 text-sky-200 hover:bg-sky-500/25 active:scale-95 transition-[background-color,transform] disabled:opacity-60">
                  {isPremium ? <Search size={18} />
                    : checkingPremium ? <Loader size={16} className="animate-spin" />
                    : <Lock size={16} className="text-slate-300" />}
                  {t("routeFinder.button")}
                  {!isPremium && (
                    <span className="text-[11px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 bg-orange-500/20 border border-orange-500/40 text-orange-200">
                      {t("premium.badge")}
                    </span>
                  )}
                </button>
              )
            )}
          </>
        )}
        {state === "tracking" && (
          <div className="flex gap-2">
            <Ctrl onClick={rt.pause} color="bg-slate-700 hover:bg-slate-600 text-slate-100"><Pause size={20} />{t("tracker.controls.pause")}</Ctrl>
            <Ctrl onClick={finishRun} color="bg-red-500 hover:bg-red-600 text-white"><Square size={18} />{t("tracker.controls.finish")}</Ctrl>
          </div>
        )}
        {state === "paused" && (
          <div className="flex gap-2">
            <Ctrl onClick={() => guardedStart(rt.resume)} color="bg-orange-500 hover:bg-orange-600 text-white"><Play size={20} />{t("tracker.controls.resume")}</Ctrl>
            <Ctrl onClick={finishRun} color="bg-red-500 hover:bg-red-600 text-white"><Square size={18} />{t("tracker.controls.finish")}</Ctrl>
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

        {/* A broadcast in progress must be visible on the recording device — an
            invisible one is a privacy problem, not a feature. */}
        {live && sharing && (
          <>
            <p className="flex items-center justify-center gap-1.5 text-[11px] text-emerald-300/90">
              <Radio size={12} />{t("liveShare.toggle.label")} · {t("liveShare.toggle.on")}
              {shareToken ? <> · {t("liveShare.link.active")}</> : null}
            </p>
            {shareLinkRow}
          </>
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

      {confirmDiscard && (
        <ModalOverlay>
          <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-slate-700 p-4 space-y-3">
            <p className="text-sm text-slate-200">{t("tracker.discardConfirm")}</p>
            <ConfirmButtons cancelLabel={t("common.cancel")} acceptLabel={t("tracker.controls.discard")}
              onCancel={() => setConfirmDiscard(false)} onAccept={discardRun} />
          </div>
        </ModalOverlay>
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
          initialKm={initialFindKm}
          onSelect={setPlannedRoute}
          onClose={() => setShowFinder(false)} />
      )}

      {premiumTeaser && (
        <PremiumTeaserSheet feature={premiumTeaser} onClose={() => setPremiumTeaser(null)} />
      )}
    </div>
  );
}
