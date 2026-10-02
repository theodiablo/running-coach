import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  advanceWorkout, hrOver, initialWorkoutProgress, paceVerdict, stepAt, stepRemaining,
  type PaceVerdict, type Workout, type WorkoutProgress, type WorkoutStep,
} from "../utils/workout";
import { calloutContent, calloutDue, hrWarnDue, type AudioPrefs, type CalloutClock, type CalloutContent } from "../utils/callout";
import { cancelScheduledCue, playCue, releaseCues, scheduleCue } from "../cues";
import { clearWorkoutGuide, seedWorkoutGuide } from "../geo/workoutGuide";
import { isAndroid } from "../native";
import { fmt } from "../utils/format";
import { isHrStale } from "../utils/hr";
import { track } from "../telemetry";

// Guided-run orchestration (docs/guided-workouts.md). Advances the pure engine
// off the SAME renders the tracker's accepted fixes and foreground 1s tick
// already produce (never a timer — the repo's background rule), and fans the
// results out to:
//   - the in-tracker panel (returned display state),
//   - JS cues and status callouts (web + iOS; Android is silent here — its
//     native engine owns audio),
//   - the iOS native one-shot schedule for time boundaries no fix will wake,
//   - the Android WorkoutGuide seed (full state re-base on every change).
// Engine progress is DERIVED DURING RENDER (the PlanView reset pattern — no
// sync setState in effects); the cue effect below only performs side effects.

// Re-arm the iOS scheduled cue only when the deadline drifted meaningfully —
// re-arming on every 1s tick would spam the bridge for nothing.
const SCHEDULE_DRIFT_MS = 2_500;

// The plural follows the one-decimal figure actually spoken ("1,5 kilomètre").
const kmCount = (km: number) => Math.round(km * 10) / 10;

const paceParts = (pace: number) => {
  const p = Math.round(pace);
  return { min: Math.floor(p / 60), sec: String(p % 60).padStart(2, "0") };
};

type TrackerStats = { km: number; movingSec: number; curPace: number; hr?: number | null; hrAt?: number | null };
type TrackerState = "idle" | "tracking" | "paused" | "stopped";

export type GuidedDisplay = {
  step: WorkoutStep;
  label: string;
  detail: string;
  remaining: { m?: number; sec?: number };
  nextLabel: string | null;
  verdict: PaceVerdict | null;
  hrHigh: boolean;
  finished: boolean;
  /** One-line summary for lock-screen surfaces (iOS Live Activity). */
  stepText: string;
};

export function useGuidedWorkout({ workout, audioOn, prefs, state, stats, kind }: {
  /** Null = nothing to guide (an open run with audio off). */
  workout: Workout | null;
  audioOn: boolean;
  prefs: AudioPrefs;
  state: TrackerState;
  stats: TrackerStats;
  /** Telemetry only: which kind of run is being guided. */
  kind: string;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || "en";
  const liveBpm = stats.hr != null && !isHrStale(stats.hrAt) ? stats.hr : null;

  // ── engine progress, derived during render ────────────────────────────────
  const [progress, setProgress] = useState<WorkoutProgress>(initialWorkoutProgress);
  const [prevState, setPrevState] = useState<TrackerState>(state);
  const [prevWorkout, setPrevWorkout] = useState<Workout | null>(workout);
  let cur = progress;
  if (state !== prevState) {
    setPrevState(state);
    // Fresh start, or full tracker reset (discard): restart the schedule. A
    // recovered run resumes paused→tracking and keeps its catch-up instead —
    // the engine walks forward through the recovered distance/time.
    if ((state === "tracking" && prevState === "idle") || state === "idle") {
      cur = initialWorkoutProgress;
      setProgress(cur);
    }
  }
  if (workout !== prevWorkout) {
    // A different schedule (edited before Start, or audio switched on for an
    // open run mid-way) starts from where the runner is now.
    setPrevWorkout(workout);
    cur = { idx: 0, stepStartKm: stats.km, stepStartSec: stats.movingSec, done: false };
    setProgress(cur);
  }
  if (workout && state === "tracking") {
    const res = advanceWorkout(workout, cur, { km: stats.km, movingSec: stats.movingSec });
    if (res.entered.length || res.finished) {
      cur = res.progress;
      setProgress(cur);
    }
  }

  // ── copy builders (bound t; all strings pre-rendered for native seeds) ────
  const spokenDist = useCallback((m: number) =>
    m % 1000 === 0 ? t("tracker.guided.speak.km", { count: m / 1000 }) : t("tracker.guided.speak.metres", { count: m }), [t]);
  // Seconds spoken as "4 35" (two-digit), which TTS reads naturally in every
  // locale — "4:35" is read as a clock time by some voices.
  const spokenPace = useCallback((pace: number) => t("tracker.guided.speak.pace", paceParts(pace)), [t]);
  const shortPace = useCallback((pace: number) => t("tracker.guided.speak.paceShort", paceParts(pace)), [t]);
  const spokenKm = useCallback((km: number) =>
    km.toLocaleString(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), [lang]);

  const announceFor = useCallback((step: WorkoutStep): string => {
    const mins = step.sec != null ? Math.round(step.sec / 60) : 0;
    switch (step.kind) {
      case "warmup": return t("tracker.guided.speak.warmup", { count: mins });
      case "cooldown": return t("tracker.guided.speak.cooldown", { count: mins });
      case "run":
      case "walk":
        // Run/walk ratios can be sub-minute (a 30 s walk), so only whole minutes are said as minutes.
        return step.sec != null && step.sec % 60 !== 0
          ? t(`tracker.guided.speak.${step.kind}Sec`, { count: step.sec })
          : t(`tracker.guided.speak.${step.kind}`, { count: mins });
      case "recover": return step.m != null
        ? t("tracker.guided.speak.recoverDist", { dist: spokenDist(step.m) })
        : t("tracker.guided.speak.recoverSec", { count: step.sec });
      case "steady": {
        if (step.m != null) return step.pace
          ? t("tracker.guided.speak.steadyDist", { dist: spokenDist(step.m), pace: spokenPace(step.pace) })
          : t("tracker.guided.speak.steadyDistNoPace", { dist: spokenDist(step.m) });
        if (step.sec != null) return step.pace
          ? t("tracker.guided.speak.steadyTime", { count: mins, pace: spokenPace(step.pace) })
          : t("tracker.guided.speak.steadyTimeNoPace", { count: mins });
        return step.pace ? t("tracker.guided.speak.steadyTarget", { pace: spokenPace(step.pace) }) : t("tracker.guided.speak.steadyOpen");
      }
      default: {
        if (step.rep != null) {
          const dist = step.m != null ? spokenDist(step.m) : t("tracker.guided.speak.seconds", { count: step.sec });
          return step.pace
            ? t("tracker.guided.speak.rep", { rep: step.rep, reps: step.reps, dist, pace: spokenPace(step.pace) })
            : t("tracker.guided.speak.repNoPace", { rep: step.rep, reps: step.reps, dist });
        }
        if (step.sec != null) return step.pace
          ? t("tracker.guided.speak.tempoTime", { count: mins, pace: spokenPace(step.pace) })
          : t("tracker.guided.speak.tempoTimeNoPace", { count: mins });
        return step.pace
          ? t("tracker.guided.speak.tempo", { count: (step.m || 0) / 1000, pace: spokenPace(step.pace) })
          : t("tracker.guided.speak.tempoNoPace", { count: (step.m || 0) / 1000 });
      }
    }
  }, [t, spokenDist, spokenPace]);

  const labelFor = useCallback((step: WorkoutStep): string => {
    if (step.kind === "work") return step.rep != null
      ? t("tracker.guided.label.rep", { rep: step.rep, reps: step.reps })
      : t("tracker.guided.label.tempo");
    return t("tracker.guided.label." + step.kind);
  }, [t]);

  const detailFor = useCallback((step: WorkoutStep): string => {
    const parts: string[] = [];
    if (step.m != null) parts.push(step.m % 1000 === 0 ? step.m / 1000 + " km" : step.m + " m");
    if (step.sec != null) parts.push(step.sec % 60 === 0 ? t("tracker.guided.mins", { mins: step.sec / 60 }) : fmt.dur(step.sec));
    if (step.pace) parts.push(fmt.pace(step.pace) + "/km");
    return parts.join(" · ");
  }, [t]);

  const calloutText = useCallback((c: CalloutContent): string => {
    const parts: string[] = [];
    if (c.km != null) parts.push(t("tracker.guided.speak.distDone", { count: kmCount(c.km), km: spokenKm(c.km) }));
    if (c.pace != null) {
      const pace = shortPace(c.pace);
      if (c.verdict === "on") parts.push(t("tracker.guided.speak.onPace", { pace }));
      else if (c.verdict && c.target) parts.push(t(c.verdict === "slow" ? "tracker.guided.speak.slowBy" : "tracker.guided.speak.fastBy", { pace, target: shortPace(c.target) }));
      else parts.push(t("tracker.guided.speak.paceIs", { pace }));
    }
    if (c.hr != null) parts.push(t("tracker.guided.speak.heart", { bpm: c.hr }));
    if (c.left?.m != null) parts.push(c.left.m >= 1000
      ? t("tracker.guided.speak.leftKm", { count: kmCount(c.left.m / 1000), km: spokenKm(c.left.m / 1000) })
      : t("tracker.guided.speak.leftM", { count: c.left.m }));
    else if (c.left?.sec != null) parts.push(c.left.sec > 90
      ? t("tracker.guided.speak.leftMin", { count: Math.round(c.left.sec / 60) })
      : t("tracker.guided.speak.leftSec", { count: c.left.sec }));
    return parts.join(" ");
  }, [t, shortPace, spokenKm]);

  // ── side effects: cues, callouts, telemetry, the iOS one-shot schedule ────
  const lastCuedIdxRef = useRef<number | null>(null); // null = nothing announced yet this run
  const doneCuedRef = useRef(false);
  const clockRef = useRef<CalloutClock>({ lastAtSec: 0, lastKm: 0 });
  const lastHrWarnRef = useRef(-Infinity);
  const armedDeadlineRef = useRef<number | null>(null);
  const statsRef = useRef(stats);
  useEffect(() => { statsRef.current = stats; }, [stats]);

  // Transition watcher: teardown + telemetry + cue-state resets. Side effects
  // only — the matching progress resets happen during render above.
  const prevStateFxRef = useRef<TrackerState>(state);
  useEffect(() => {
    const prev = prevStateFxRef.current;
    prevStateFxRef.current = state;
    if (workout && state === "tracking" && prev === "idle")
      track("guided_workout_started", { type: kind, audio: audioOn });
    if (state === "stopped" || state === "idle") {
      armedDeadlineRef.current = null;
      cancelScheduledCue();
      releaseCues();
      if (state === "idle") {
        lastCuedIdxRef.current = null;
        doneCuedRef.current = false;
        clockRef.current = { lastAtSec: 0, lastKm: 0 };
        lastHrWarnRef.current = -Infinity;
      }
    }
    // Pause freezes the moving clock — a still-armed iOS one-shot would fire
    // on wall time regardless, so disarm and let resume re-arm.
    if (state === "paused" && armedDeadlineRef.current != null) {
      armedDeadlineRef.current = null;
      cancelScheduledCue();
    }
  }, [state, workout, kind, audioOn]);

  useEffect(() => {
    if (!workout || state !== "tracking") return;
    if (progress.done) {
      if (!doneCuedRef.current) {
        doneCuedRef.current = true;
        armedDeadlineRef.current = null;
        cancelScheduledCue();
        if (audioOn) playCue("done", t("tracker.guided.speak.done"), lang);
        track("guided_workout_finished", {});
      }
      return;
    }
    const step = stepAt(workout, progress.idx);
    if (!step) return;
    // Announce the step the runner is IN (the first announcement covers the
    // warm-up right after Go; a multi-boundary catch-up lands on where they
    // are now, skipping the steps that flew by while JS was frozen).
    if (lastCuedIdxRef.current !== progress.idx) {
      // First announcement of this guidance (a fresh start, a recovered run, audio
      // switched on mid-run): per-km callouts count from where the runner is.
      const lastKm = lastCuedIdxRef.current == null ? Math.floor(stats.km) : clockRef.current.lastKm;
      lastCuedIdxRef.current = progress.idx;
      if (audioOn) playCue("step", announceFor(step), lang);
      clockRef.current = { lastAtSec: stats.movingSec, lastKm };
    } else if (audioOn) {
      if (hrWarnDue(step, prefs.hrWarn, liveBpm, stats.movingSec, lastHrWarnRef.current)) {
        lastHrWarnRef.current = stats.movingSec;
        clockRef.current = { ...clockRef.current, lastAtSec: stats.movingSec };
        playCue("fast", t("tracker.guided.speak.hrHigh", { bpm: liveBpm }), lang);
      } else if (calloutDue(prefs.freq, { movingSec: stats.movingSec, km: stats.km, stepElapsedSec: stats.movingSec - progress.stepStartSec }, clockRef.current)) {
        clockRef.current = { lastAtSec: stats.movingSec, lastKm: Math.floor(stats.km) };
        const text = calloutText(calloutContent(prefs.say, step,
          { km: stats.km, curPace: stats.curPace, hr: liveBpm, left: stepRemaining(step, progress, stats) }, prefs.freq === "km"));
        if (text) playCue("info", text, lang);
      }
    }
    // iOS: arm the native one-shot for a time boundary (a standing recovery
    // produces no fixes to wake JS). Distance boundaries need a fix by
    // definition, so nothing is armed for them. Never armed with audio off,
    // and switching it off mid-step cancels the one already armed.
    if (step.sec != null && audioOn) {
      const remaining = stepRemaining(step, progress, stats);
      const inMs = (remaining.sec ?? 0) * 1000;
      const deadline = Date.now() + inMs;
      if (armedDeadlineRef.current == null || Math.abs(deadline - armedDeadlineRef.current) > SCHEDULE_DRIFT_MS) {
        armedDeadlineRef.current = deadline;
        const next = stepAt(workout, progress.idx + 1);
        if (next) scheduleCue(inMs, "step", announceFor(next), lang);
        else scheduleCue(inMs, "done", t("tracker.guided.speak.done"), lang);
      }
    } else if (armedDeadlineRef.current != null) {
      armedDeadlineRef.current = null;
      cancelScheduledCue();
    }
  }, [workout, state, progress, stats, liveBpm, audioOn, prefs, announceFor, calloutText, lang, t]);

  // ── Android native engine: full-state re-base on every material change ────
  const seededRef = useRef(false);
  useEffect(() => {
    if (!isAndroid) return;
    const live = state === "tracking" || state === "paused";
    if (!workout || !live) {
      if (seededRef.current) { seededRef.current = false; clearWorkoutGuide(); }
      return;
    }
    seededRef.current = true;
    const s = statsRef.current;
    // Callout templates keep {placeholders} for the numbers only the native
    // side knows once JS is frozen.
    const ph = { pace: "{pace}", target: "{target}", bpm: "{bpm}", km: "{km}" };
    seedWorkoutGuide({
      steps: workout.steps.map(step => ({
        kind: step.kind,
        ...(step.m != null ? { m: step.m } : {}),
        ...(step.sec != null ? { sec: step.sec } : {}),
        ...(step.pace ? { pace: step.pace, band: step.band } : {}),
        ...(step.hrHi != null ? { hrLo: step.hrLo, hrHi: step.hrHi } : {}),
        announce: announceFor(step),
        notif: [labelFor(step), detailFor(step)].filter(Boolean).join(" · "),
      })),
      ...(workout.loopFrom != null ? { loopFrom: workout.loopFrom } : {}),
      idx: progress.idx,
      stepStartKm: progress.stepStartKm,
      stepStartSec: progress.stepStartSec,
      km: s.km,
      movingSec: s.movingSec,
      tracking: state === "tracking",
      finished: progress.done,
      muted: !audioOn,
      lang,
      callout: {
        freqSec: prefs.freq === "km" ? 0 : prefs.freq,
        say: prefs.say,
        hrWarn: prefs.hrWarn === "off" ? -1 : prefs.hrWarn,
      },
      decimalSep: (1.5).toLocaleString(lang).charAt(1),
      // French takes the singular below 2 ("1,5 kilomètre"); en/es only at exactly 1.
      kmOneBelowTwo: new Intl.PluralRules(lang).select(1.5) === "one",
      texts: {
        notifTitle: t("tracker.guided.notifTitle"),
        done: t("tracker.guided.speak.done"),
        pace: t("tracker.guided.speak.paceShort", { min: "{min}", sec: "{sec}" }),
        onPace: t("tracker.guided.speak.onPace", ph),
        slowBy: t("tracker.guided.speak.slowBy", ph),
        fastBy: t("tracker.guided.speak.fastBy", ph),
        paceIs: t("tracker.guided.speak.paceIs", ph),
        heart: t("tracker.guided.speak.heart", ph),
        distDoneOne: t("tracker.guided.speak.distDone_one", ph),
        distDoneOther: t("tracker.guided.speak.distDone_other", ph),
        leftKmOne: t("tracker.guided.speak.leftKm_one", ph),
        leftKmOther: t("tracker.guided.speak.leftKm_other", ph),
        leftMOne: t("tracker.guided.speak.leftM_one", { count: "{n}" }),
        leftMOther: t("tracker.guided.speak.leftM_other", { count: "{n}" }),
        leftSecOne: t("tracker.guided.speak.leftSec_one", { count: "{n}" }),
        leftSecOther: t("tracker.guided.speak.leftSec_other", { count: "{n}" }),
        leftMinOther: t("tracker.guided.speak.leftMin_other", { count: "{n}" }),
        hrHigh: t("tracker.guided.speak.hrHigh", ph),
      },
    });
  }, [workout, state, progress, audioOn, prefs, lang, announceFor, labelFor, detailFor, t]);

  // Tear down everything native on unmount (header go-Home mid-run).
  useEffect(() => () => {
    cancelScheduledCue();
    releaseCues();
    if (seededRef.current) clearWorkoutGuide();
  }, []);

  // ── display state (derived at render; cheap) ──────────────────────────────
  const display = useMemo<GuidedDisplay | null>(() => {
    if (!workout) return null;
    // A finished workout's idx points past the end — fall back to the last
    // real step so the "workout complete" card (and the Live Activity's
    // doneShort line) render instead of the panel vanishing at the finish.
    const step = stepAt(workout, cur.done ? Math.max(0, cur.idx - 1) : cur.idx);
    if (!step) return null;
    const next = cur.done ? null : stepAt(workout, cur.idx + 1);
    const label = labelFor(step);
    const detail = detailFor(step);
    const live = state === "tracking" && !cur.done;
    return {
      step,
      label,
      detail,
      remaining: cur.done ? {} : stepRemaining(step, cur, stats),
      nextLabel: next ? [labelFor(next), detailFor(next)].filter(Boolean).join(" · ") : null,
      verdict: live ? paceVerdict(step, stats.curPace) : null,
      hrHigh: live && hrOver(step, liveBpm),
      finished: cur.done,
      stepText: cur.done ? t("tracker.guided.doneShort") : [label, detail].filter(Boolean).join(" · "),
    };
  }, [workout, cur, stats, liveBpm, state, labelFor, detailFor, t]);

  // The audio sheet's "Hear it": a mid-run callout for this workout, with made-up numbers.
  const sample = useCallback((p: AudioPrefs): string => {
    const step: WorkoutStep = workout?.steps.find(x => x.kind === "work" || x.kind === "steady" || x.kind === "run") ?? { kind: "steady" };
    const left = step.m != null ? { m: Math.round(step.m / 2) } : step.sec != null ? { sec: Math.round(step.sec / 2) } : {};
    const hr = step.hrLo != null && step.hrHi != null ? Math.round((step.hrLo + step.hrHi) / 2) : 148;
    return calloutText(calloutContent(p.say, step,
      { km: 4.2, curPace: step.pace ? step.pace + 3 : 338, hr, left }, p.freq === "km"));
  }, [workout, calloutText]);

  return { active: !!workout, display, sample };
}
