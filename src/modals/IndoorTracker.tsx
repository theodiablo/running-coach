import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Play, Pause, Square, X, Loader, HeartPulse, Bike } from "lucide-react";
import { fmt, ymd } from "../utils/format";
import { persistImportedRoute } from "../imports/persistRoutes";
import { useRunTracker } from "../hooks/useRunTracker";
import { useCountdown } from "../hooks/useCountdown";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { useDismissable } from "../hooks/useDismissable";
import { getHrSource } from "../hr/source";
import { readHrJournal } from "../hr/hrJournal";
import { HR_MIN_COVERAGE, effectiveMaxHR, hrCoverage, hrSummary, mergeHrSamples } from "../utils/hr";
import { getPairedDevice } from "../hr/device";
import { hasHealthConnectAuthorization } from "../hr/healthconnect";
import { hasHealthKitAuthorization } from "../healthkit/import";
import { LiveHrZone } from "../components/LiveHrZone";
import { HRTarget } from "../components/HRTarget";
import { ModalOverlay, ConfirmButtons } from "../components/ModalPrimitives";
import { BetaBadge } from "../components/BetaBadge";
import { isNative, isAndroid, isIos } from "../native";
import { INDOOR_ACTIVITY_KEY } from "../constants";
import { track } from "../telemetry";
import { hrNudgeFor } from "../utils/hrNudge";
import { RUN_ACTIVITIES, type HrMethod, type Run, type RunActivity, type SettingsState } from "../types";

type IndoorTrackerProps = {
  onFinish: (prefill: Partial<Run>) => void;
  onClose: () => void;
  showToast?: (msg: string, type?: string) => void;
  settings: SettingsState;
  hrMethod: HrMethod;
  hrOptOut?: boolean;
  onConfigureHr?: () => void;
  onDeclineHr?: () => void;
};

// Indoor / static cardio recorder — a stationary bike or elliptical, where the
// machine tells us nothing and heart rate is the whole signal. Deliberately a
// separate screen from LiveRunTracker rather than a mode inside it: none of
// that screen's map, live sharing, route finder, guided workouts or
// background-location consent apply with no GPS, and threading an `indoor`
// branch through all of it would leave two half-features. See
// docs/indoor-sessions.md.
export function IndoorTracker({ onFinish, onClose, showToast, settings, hrMethod, hrOptOut, onConfigureHr, onDeclineHr }: IndoorTrackerProps) {
  const { t } = useTranslation();
  const pairedHrDevice = getPairedDevice();
  const healthConnectAuthorized = hasHealthConnectAuthorization();
  const healthKitAuthorized = hasHealthKitAuthorization();
  // Same two-key rule as LiveRunTracker: the synced method is only a preference,
  // so the per-device pairing/grant must also be present before a bridge is used.
  const hrReady = !isNative
    || (hrMethod || "off") === "off"
    || (hrMethod === "bluetooth" && !!pairedHrDevice)
    || (hrMethod === "healthconnect" && healthConnectAuthorized)
    || (hrMethod === "healthkit" && healthKitAuthorized);
  const effectiveHrMethod = hrReady ? hrMethod : "off";
  const rt = useRunTracker({ hrMethod: effectiveHrMethod, indoor: true });
  const { state, stats, pending } = rt;
  const [busy, setBusy] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  const [activity, setActivity] = useState<RunActivity>(() => {
    try {
      const saved = localStorage.getItem(INDOOR_ACTIVITY_KEY);
      if (saved && (RUN_ACTIVITIES as string[]).includes(saved)) return saved as RunActivity;
    } catch { /* unavailable — fall through to the default */ }
    return "bike";
  });
  const pickActivity = (a: RunActivity) => {
    setActivity(a);
    try { localStorage.setItem(INDOOR_ACTIVITY_KEY, a); } catch { /* quota — non-fatal */ }
  };

  const hrSrc = getHrSource(effectiveHrMethod);
  const liveHr = !!hrSrc?.live;
  const effMax = effectiveMaxHR(settings);
  const restHR = settings.restHR || 60;
  const live = state === "tracking" || state === "paused";

  // Same nudge rules as the run tracker — an indoor session with no HR source is
  // the one case where the whole point of the screen is missing, but it still
  // never blocks Start.
  const [showHrNudge, setShowHrNudge] = useState(false);
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

  const startSession = () => {
    track("indoor_session_started", { activity });
    rt.start();
  };
  const countdown = useCountdown(startSession);
  const startWithCountdown = () => (reducedMotion ? startSession() : countdown.start(3));
  // The nudge replaces this Start; the deferred action runs once it's dismissed.
  const handleStart = () => {
    if (hrNudge) { setShowHrNudge(true); return; }
    startWithCountdown();
  };
  const dismissHrNudge = (thenStart: boolean) => {
    setShowHrNudge(false);
    if (thenStart) startWithCountdown();
  };

  const finishSession = () => {
    track("indoor_session_stopped", { activity, durationSec: stats.movingSec });
    rt.stop();
  };

  // Discarding asks first, through an IN-DOM sheet rather than window.confirm:
  // that call blocks the WebView's JS thread until the native dialog answers,
  // and a dialog raised as the activity backgrounds (the Android back gesture
  // routes here) can never answer — freezing the recorder mid-session with the
  // clock and heart rate stopped and every button dead.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const discardSession = () => {
    setConfirmDiscard(false);
    if (live || state === "stopped") rt.reset();
    onClose();
  };
  const handleClose = () => {
    if ((live || state === "stopped") && stats.movingSec > 0) { setConfirmDiscard(true); return; }
    discardSession();
  };

  const handleSave = async () => {
    setBusy(true);
    const { startedAt, stoppedAt } = rt.runWindow();
    // Heart rate, exactly as LiveRunTracker resolves it: a live source has
    // already filled hrAvg/hrMax; a post-run source (Health Connect / Apple
    // Health) is queried now over the session's window, and stamps a pending
    // marker if the store hasn't synced yet so RunningCoach relinks on the next
    // load. Without this the "added after you finish" line above is a promise
    // the save never keeps. Branching on hrSrc, not a method id, so a future
    // post-run source needs no edit here.
    //
    // Fold in the native HR journal first, for the same reason the run tracker
    // does — and more so here: an indoor session has no location service, so
    // backgrounding it freezes JS immediately and the journal is the only record
    // of that stretch. Read it ONLY for a live source, the same condition that
    // armed it; anything on disk under a post-run source belongs to an earlier
    // BLE run, and merging it would both invent this session's HR and skip the
    // store fetch below by producing an average.
    const hrSamples = mergeHrSamples(rt.hrSamples, hrSrc?.live ? await readHrJournal() : []);
    const hrStats = hrSummary(hrSamples);
    const coverage = hrCoverage(hrSamples, stats.movingSec);
    let hr = null, hrMax = null, hrPending = null;
    if (hrStats.hrAvg != null) {
      // Same coverage guard as a run: a strap that dropped halfway leaves the
      // mean of whatever survived, and on this screen heart rate IS the session,
      // so quoting a fragment's average would misreport the whole thing. Below
      // the threshold the samples still save (the detail chart draws them) and
      // hrCoverage records how much was measured.
      if (coverage >= HR_MIN_COVERAGE) { hr = hrStats.hrAvg; hrMax = hrStats.hrMax; }
      else showToast?.(t("tracker.hr.partial", { pct: Math.round(coverage * 100) }), "err");
    }
    else if (hrSrc && !hrSrc.live) {
      const startMs = startedAt || Date.now();
      const endMs = stoppedAt || Date.now();
      let res = null;
      try { res = await (hrSrc as { fetchRange: (s: number, e: number) => Promise<{ hrAvg?: number; hrMax?: number }> }).fetchRange(startMs, endMs); } catch { /* unsynced — leave null */ }
      if (res && res.hrAvg) { hr = res.hrAvg; hrMax = res.hrMax ?? null; }
      else hrPending = { start: startMs, end: endMs, source: hrSrc.id };
    }
    // No distance axis at all: km stays 0 so running volume, pace, PBs and the
    // race predictor never see a bike session (docs/indoor-sessions.md).
    // bestEfforts is stamped empty ON PURPOSE — "measured, covers no standard
    // distance" — so the one-time backfill never revisits this run.
    //
    // persistImportedRoute is the one place that turns a raw HR series into a
    // run_routes row; with no points it returns hrRouteId, exactly the shape a
    // health-store import produces, so run detail's HR chart and time-in-zone
    // card work with nothing new. Its offline behaviour applies too: the raw
    // stream is dropped rather than queued, and the avg/max still save.
    const prefill = await persistImportedRoute({
      date: ymd(new Date(startedAt || Date.now())),
      type: "OTHER",
      km: 0,
      durationSec: stats.movingSec,
      activity,
      source: "indoor",
      bestEfforts: {},
      ...(hr != null ? { hr, hrMax } : {}),
      // How much of the session the sensor actually measured, so no surface has
      // to guess whether the stored series is the whole thing or a fragment.
      ...(hrSamples.length ? { hrCoverage: +coverage.toFixed(2) } : {}),
      // The HealthKit marker rides its own field: shipped Android clients strip
      // any hrPending whose source isn't "healthconnect" from the synced blob.
      ...(hrPending ? (hrPending.source === "healthkit" ? { hrPendingHk: hrPending } : { hrPending }) : {}),
      ...(startedAt ? { startedAt: new Date(startedAt).toISOString() } : {}),
      hrSamples,
    });
    rt.finalize();
    setBusy(false);
    onFinish(prefill);
  };

  // Back/Escape, innermost first: countdown → HR nudge → discard confirm → the
  // screen itself (through handleClose, so an in-progress session raises the
  // discard confirm rather than closing).
  useDismissable(true, handleClose);
  useDismissable(confirmDiscard, () => setConfirmDiscard(false));
  useDismissable(showHrNudge, () => dismissHrNudge(false));
  useDismissable(countdown.count !== null, countdown.cancel);

  const clock = fmt.dur(stats.movingSec) === "--" ? "0:00" : fmt.dur(stats.movingSec);

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
            <Bike size={15} className="text-violet-400" />
          )}
          <span className="text-sm font-semibold">
            {state === "stopped" ? t("tracker.indoor.complete") : t("tracker.indoor.title")}
          </span>
        </div>
        <button onClick={handleClose} aria-label={t("common.close")}
          className="text-slate-400 hover:text-white p-1.5"><X size={18} /></button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col justify-center p-4 gap-5">
        {/* The whole point of the screen: heart rate, big enough to read from
            the handlebars, with the zone it lands in. */}
        <div className="text-center">
          <p className="flex items-center justify-center gap-2 text-slate-400 text-xs uppercase tracking-wide">
            <HeartPulse size={14} className={stats.hr != null ? "text-red-400" : "text-slate-600"} />
            {t("tracker.hr.bpm")}
            <BetaBadge />
          </p>
          <p className="text-7xl font-extrabold text-white tabular-nums leading-none mt-1">{stats.hr ?? "--"}</p>
          <p className="text-xs text-slate-500 mt-2">
            {!liveHr ? (hrSrc
              ? t("tracker.hr.postRun", { store: hrSrc.id === "healthkit" ? "Apple Health" : "Health Connect" })
              : t("tracker.indoor.noSensor"))
              : stats.hrAvg != null ? t("tracker.hr.avgMax", { avg: stats.hrAvg, max: stats.hrMax })
              : stats.hr != null ? t("tracker.hr.connected")
              : rt.hrStatus === "unreachable" ? t("tracker.hr.cantReach")
              : t("tracker.hr.connecting")}
          </p>
        </div>

        <LiveHrZone bpm={stats.hr} effMax={effMax} restHR={restHR} />

        <div className="text-center">
          <p className="text-5xl font-bold text-white tabular-nums leading-none">{clock}</p>
          <p className="text-[11px] text-slate-400 uppercase tracking-wide mt-1.5">{t("tracker.stats.time")}</p>
        </div>

        {state === "idle" && (
          <div className="space-y-3">
            <div>
              <p className="text-xs text-slate-400 mb-1.5">{t("tracker.indoor.machine")}</p>
              <div className="grid grid-cols-4 gap-2">
                {RUN_ACTIVITIES.map(a => (
                  <button key={a} onClick={() => pickActivity(a)} aria-pressed={activity === a}
                    className={"py-2 rounded-xl text-xs font-semibold border transition-colors "
                      + (activity === a
                        ? "bg-violet-500/20 border-violet-500/50 text-violet-200"
                        : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700")}>
                    {t("common.activities." + a)}
                  </button>
                ))}
              </div>
            </div>
            {/* Cross-training targets the aerobic base zone — the same band the
                plan's "Optional cross-training" day is asking for. */}
            <div className="text-center">
              <HRTarget type="OTHER" settings={settings} openSettings={() => onConfigureHr?.()} />
            </div>
          </div>
        )}
      </div>

      <div className="p-4 space-y-3 border-t border-slate-800" style={{ paddingBottom: "calc(1rem + var(--safe-bottom))" }}>
        {state === "idle" && pending && (
          <div className="bg-slate-800 rounded-xl p-3 space-y-2 border border-slate-700">
            <p className="text-sm text-slate-200">{t("tracker.indoor.resumeTitle")}
              <span className="text-slate-400"> {t("tracker.indoor.resumeElapsed", { time: fmt.dur(Math.round(pending.accSec)) })}</span></p>
            <div className="flex gap-2">
              <button onClick={rt.resumePrevious}
                className="flex-1 bg-orange-500 hover:bg-orange-600 text-white py-2 rounded-lg text-sm font-semibold">{t("tracker.resume.resume")}</button>
              <button onClick={rt.discardPrevious}
                className="px-4 bg-slate-700 hover:bg-slate-600 text-slate-200 py-2 rounded-lg text-sm font-semibold">{t("tracker.resume.discard")}</button>
            </div>
          </div>
        )}

        {state === "idle" && (
          <div className="flex">
            <Ctrl onClick={handleStart} color="bg-orange-500 hover:bg-orange-600 text-white">
              <Play size={20} />{t("tracker.indoor.start")}
            </Ctrl>
          </div>
        )}
        {state === "tracking" && (
          <div className="flex gap-2">
            <Ctrl onClick={rt.pause} color="bg-slate-700 hover:bg-slate-600 text-slate-100"><Pause size={20} />{t("tracker.controls.pause")}</Ctrl>
            <Ctrl onClick={finishSession} color="bg-red-500 hover:bg-red-600 text-white"><Square size={18} />{t("tracker.controls.finish")}</Ctrl>
          </div>
        )}
        {state === "paused" && (
          <div className="flex gap-2">
            <Ctrl onClick={rt.resume} color="bg-orange-500 hover:bg-orange-600 text-white"><Play size={20} />{t("tracker.controls.resume")}</Ctrl>
            <Ctrl onClick={finishSession} color="bg-red-500 hover:bg-red-600 text-white"><Square size={18} />{t("tracker.controls.finish")}</Ctrl>
          </div>
        )}
        {state === "stopped" && (
          <div className="flex gap-2">
            <Ctrl onClick={handleClose} color="bg-slate-700 hover:bg-slate-600 text-slate-100" disabled={busy}>{t("tracker.controls.discard")}</Ctrl>
            <Ctrl onClick={handleSave} color="bg-orange-500 hover:bg-orange-600 text-white" disabled={busy}>
              {busy ? <Loader size={18} className="animate-spin" /> : null}{t("tracker.indoor.save")}
            </Ctrl>
          </div>
        )}

        {/* Honest, and load-bearing: with no location session there is no Android
            foreground service and no iOS background execution, so the session
            only survives while this screen is up. */}
        {live && (
          <p className="text-[11px] text-slate-500 text-center leading-snug">{t("tracker.indoor.keepScreenOn")}</p>
        )}
      </div>

      {confirmDiscard && (
        <ModalOverlay>
          <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-slate-700 p-4 space-y-3">
            <p className="text-sm text-slate-200">{t("tracker.indoor.discardConfirm")}</p>
            <ConfirmButtons cancelLabel={t("common.cancel")} acceptLabel={t("tracker.controls.discard")}
              onCancel={() => setConfirmDiscard(false)} onAccept={discardSession} />
          </div>
        </ModalOverlay>
      )}

      {showHrNudge && (
        <ModalOverlay>
          <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-slate-700 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <HeartPulse size={16} className="text-orange-400" />
              <p className="font-semibold text-sm">{hrNudge?.title || t("tracker.hrNudge.setupTitle")}</p>
              <BetaBadge label={t("tracker.hrNudge.newBeta")} />
            </div>
            <p className="text-sm text-slate-300">{hrNudge?.body || t("tracker.hrNudge.setupBody")}</p>
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
    </div>
  );
}

// Large, glove-friendly control button — the same shape as the run tracker's.
function Ctrl({ onClick, color, children, disabled = false }: { onClick: () => void; color: string; children: ReactNode; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={"flex-1 flex items-center justify-center gap-2 py-4 rounded-2xl text-base font-semibold transition-[background-color,transform] active:scale-95 disabled:opacity-50 disabled:active:scale-100 " + color}>
      {children}
    </button>
  );
}
