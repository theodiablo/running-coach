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
import { effectiveHrMethod, resolveRunHr, runHrFields } from "../hr/runHr";
import { effectiveMaxHR, isHrStale, liveHrStatusLine } from "../utils/hr";
import { getPairedDevice } from "../hr/device";
import { hasHealthConnectAuthorization } from "../hr/healthconnect";
import { hasHealthKitAuthorization } from "../healthkit/import";
import { HrNudgeSheet } from "../components/HrNudgeSheet";
import { LiveHrZone } from "../components/LiveHrZone";
import { HRTarget } from "../components/HRTarget";
import { ModalOverlay, ConfirmButtons } from "../components/ModalPrimitives";
import { BetaBadge } from "../components/BetaBadge";
import { isNative, isAndroid, isIos } from "../native";
import { INDOOR_ACTIVITY_KEY } from "../constants";
import { track } from "../telemetry";
import { hrNudgeFor } from "../utils/hrNudge";
import { RUN_ACTIVITIES, type HrMethod, type Run, type RunActivity, type SettingsPage, type SettingsState } from "../types";

type IndoorTrackerProps = {
  onFinish: (prefill: Partial<Run>) => void;
  onClose: () => void;
  showToast?: (msg: string, type?: string) => void;
  settings: SettingsState;
  hrMethod: HrMethod;
  hrOptOut?: boolean;
  onConfigureHr?: (page?: SettingsPage) => void;
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
  // Same readiness rule as LiveRunTracker, from the same helper: the synced
  // method is only a preference, so the per-device pairing/grant must also be
  // present before a bridge is used.
  const hrMethodHere = effectiveHrMethod(hrMethod);
  const rt = useRunTracker({ hrMethod: hrMethodHere, indoor: true });
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

  const hrSrc = getHrSource(hrMethodHere);
  const liveHr = !!hrSrc?.live;
  const effMax = effectiveMaxHR(settings);
  const restHR = settings.restHR || 60;
  const live = state === "tracking" || state === "paused";
  // A strap that dies leaves its last bpm on screen forever, and once one sample
  // is recorded hrAvg is non-null for the rest of the session, so the status
  // line below would read "avg · max" and never surface hrStatus again. Read at
  // render time: the 1s clock tick re-renders while tracking, and an hrStatus
  // change re-renders while idle, so this refreshes without a timer of its own.
  const hrStale = liveHr && isHrStale(stats.hrAt);
  // Same ladder as the run recorder's, from the same helper.
  const hrLine = liveHrStatusLine({ stale: hrStale, status: rt.hrStatus, hrAvg: stats.hrAvg, hrMax: stats.hrMax, hr: stats.hr });

  // Same nudge rules as the run tracker — an indoor session with no HR source is
  // the one case where the whole point of the screen is missing, but it still
  // never blocks Start.
  const [showHrNudge, setShowHrNudge] = useState(false);
  const hrNudgeChoice = hrNudgeFor({
    isNative, isAndroid, isIos, hrMethod,
    healthConnectAuthorized, healthKitAuthorized,
    pairedHrDevice: !!pairedHrDevice, hrOptOut: !!hrOptOut,
  });

  const startSession = () => {
    track("indoor_session_started", { activity });
    rt.start();
  };
  const countdown = useCountdown(startSession);
  const startWithCountdown = () => (reducedMotion ? startSession() : countdown.start(3));
  // The nudge replaces this Start; the deferred action runs once it's dismissed.
  const handleStart = () => {
    if (hrNudgeChoice) { setShowHrNudge(true); return; }
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

  // In-DOM confirm, never window.confirm (see CLAUDE.md): the Android back
  // gesture routes here, and a native dialog raised as the activity backgrounds
  // never answers, freezing the recorder with it.
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
    // Heart rate through the one shared resolver (src/hr/runHr.ts) — a live
    // source's stream folded together with the native journal and coverage-
    // guarded, a post-run store queried over the session window. The journal
    // matters more here than on a run: an indoor session has no location
    // service, so backgrounding it freezes JS immediately and the journal is
    // the only record of that stretch.
    const resolved = await resolveRunHr({
      hrSrc, liveSamples: rt.hrSamples, durationSec: stats.movingSec,
      startMs: startedAt || Date.now(), endMs: stoppedAt || Date.now(),
    });
    // On this screen heart rate IS the session, so a fragment's average would
    // misreport the whole thing. Run detail recomputes the coverage from the
    // samples, which save either way, to say why there is no average.
    if (resolved.partialCoverage != null)
      showToast?.(t("tracker.hr.partial", { pct: Math.round(resolved.partialCoverage * 100) }), "err");
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
      ...runHrFields(resolved),
      ...(startedAt ? { startedAt: new Date(startedAt).toISOString() } : {}),
      hrSamples: resolved.samples,
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
            <HeartPulse size={14} className={stats.hr != null && !hrStale ? "text-red-400" : "text-slate-600"} />
            {t("tracker.hr.bpm")}
            <BetaBadge />
          </p>
          <p className={"text-7xl font-extrabold tabular-nums leading-none mt-1 "
            + (hrStale ? "text-slate-600" : "text-white")}>{stats.hr ?? "--"}</p>
          <p className="text-xs text-slate-500 mt-2">
            {!liveHr ? (hrSrc
              ? t("tracker.hr.postRun", { store: hrSrc.id === "healthkit" ? "Apple Health" : "Health Connect" })
              : t("tracker.indoor.noSensor"))
              : t(hrLine.key, hrLine.params)}
          </p>
        </div>

        {/* No zone claim off a reading we no longer trust. */}
        <LiveHrZone bpm={hrStale ? null : stats.hr} effMax={effMax} restHR={restHR} />

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
              <HRTarget type="OTHER" settings={settings} openSettings={page => onConfigureHr?.(page)} />
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
          <p className="text-[11px] text-slate-500 text-center leading-snug">
            {/* A strapped session gets the foreground service and really does
                survive backgrounding; a strapless one has nothing holding it, so
                it keeps the original promise. Never claim the stronger one. */}
            {liveHr && isAndroid ? t("tracker.indoor.keepScreenOnStrap") : t("tracker.indoor.keepScreenOn")}
          </p>
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

      {showHrNudge && hrNudgeChoice && (
        <HrNudgeSheet choice={hrNudgeChoice} onDismiss={dismissHrNudge}
          onConfigure={() => onConfigureHr?.()} onDecline={onDeclineHr} />
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
