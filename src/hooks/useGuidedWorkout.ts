import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  advanceWorkout, compileWorkout, initialWorkoutProgress, paceVerdict, stepAt, stepRemaining,
  type PaceVerdict, type Workout, type WorkoutProgress, type WorkoutStep,
} from "../utils/workout";
import { cancelScheduledCue, cuesMuted, playCue, releaseCues, scheduleCue, setCuesMuted } from "../cues";
import { clearWorkoutGuide, seedWorkoutGuide } from "../geo/workoutGuide";
import { isAndroid } from "../native";
import { fmt } from "../utils/format";
import { track } from "../telemetry";
import type { PlanSession } from "../types";

// Guided-workout orchestration (docs/guided-workouts.md). Compiles the linked
// plan session, advances the pure engine off the SAME renders the tracker's
// accepted fixes and foreground 1s tick already produce (never a timer — the
// repo's background rule), and fans the results out to:
//   - the in-tracker panel (returned display state),
//   - JS cues (web + iOS; Android is silent here — its native engine owns audio),
//   - the iOS native one-shot schedule for time boundaries no fix will wake,
//   - the Android WorkoutGuide seed (full state re-base on every change).
// Engine progress is DERIVED DURING RENDER (the PlanView reset pattern — no
// sync setState in effects); the cue effect below only performs side effects.

// Pace nagging discipline: never inside the first stretch of a step (GPS pace
// needs to settle), then at most one reminder per interval.
const PACE_CUE_MIN_INTO_STEP_SEC = 20;
const PACE_CUE_EVERY_MS = 25_000;
// Re-arm the iOS scheduled cue only when the deadline drifted meaningfully —
// re-arming on every 1s tick would spam the bridge for nothing.
const SCHEDULE_DRIFT_MS = 2_500;

type TrackerStats = { km: number; movingSec: number; curPace: number };
type TrackerState = "idle" | "tracking" | "paused" | "stopped";

export type GuidedDisplay = {
  step: WorkoutStep;
  label: string;
  detail: string;
  remaining: { m?: number; sec?: number };
  nextLabel: string | null;
  verdict: PaceVerdict | null;
  finished: boolean;
  /** One-line summary for lock-screen surfaces (iOS Live Activity). */
  stepText: string;
};

export function useGuidedWorkout(
  session: PlanSession | null | undefined,
  enabled: boolean,
  state: TrackerState,
  stats: TrackerStats,
) {
  const { t, i18n } = useTranslation();
  // Compiled independently of the premium gate so the caller can tell "this
  // session is guidable" (drives the stale-entitlement re-read) apart from
  // "guidance is on"; every behavior below checks `enabled` too.
  const compiled = useMemo<Workout | null>(
    () => (session ? compileWorkout(session) : null),
    [session],
  );
  const workout = enabled ? compiled : null;

  const [muted, setMuted] = useState(cuesMuted);
  const lang = i18n.language || "en";

  // ── engine progress, derived during render ────────────────────────────────
  const [progress, setProgress] = useState<WorkoutProgress>(initialWorkoutProgress);
  const [prevState, setPrevState] = useState<TrackerState>(state);
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
  const spokenPace = useCallback((pace: number) =>
    t("tracker.guided.speak.pace", { min: Math.floor(pace / 60), sec: String(Math.round(pace % 60)).padStart(2, "0") }), [t]);

  const announceFor = useCallback((step: WorkoutStep): string => {
    const mins = step.sec != null ? Math.round(step.sec / 60) : 0;
    switch (step.kind) {
      case "warmup": return t("tracker.guided.speak.warmup", { count: mins });
      case "cooldown": return t("tracker.guided.speak.cooldown", { count: mins });
      case "run": return t("tracker.guided.speak.run", { count: mins });
      case "walk": return t("tracker.guided.speak.walk", { count: mins });
      case "recover": return step.m != null
        ? t("tracker.guided.speak.recoverDist", { dist: spokenDist(step.m) })
        : t("tracker.guided.speak.recoverSec", { count: step.sec });
      default:
        if (step.rep != null) return step.pace
          ? t("tracker.guided.speak.rep", { rep: step.rep, reps: step.reps, dist: spokenDist(step.m || 0), pace: spokenPace(step.pace) })
          : t("tracker.guided.speak.repNoPace", { rep: step.rep, reps: step.reps, dist: spokenDist(step.m || 0) });
        return step.pace
          ? t("tracker.guided.speak.tempo", { count: (step.m || 0) / 1000, pace: spokenPace(step.pace) })
          : t("tracker.guided.speak.tempoNoPace", { count: (step.m || 0) / 1000 });
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

  // ── side effects: cues, telemetry, the iOS one-shot schedule ─────────────
  const lastCuedIdxRef = useRef<number | null>(null); // null = nothing announced yet this run
  const doneCuedRef = useRef(false);
  const lastPaceCueRef = useRef(0);
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
      track("guided_workout_started", { type: String(session?.type || "") });
    if (state === "stopped" || state === "idle") {
      armedDeadlineRef.current = null;
      cancelScheduledCue();
      releaseCues();
      if (state === "idle") {
        lastCuedIdxRef.current = null;
        doneCuedRef.current = false;
        lastPaceCueRef.current = 0;
      }
    }
    // Pause freezes the moving clock — a still-armed iOS one-shot would fire
    // on wall time regardless, so disarm and let resume re-arm.
    if (state === "paused" && armedDeadlineRef.current != null) {
      armedDeadlineRef.current = null;
      cancelScheduledCue();
    }
  }, [state, workout, session]);

  useEffect(() => {
    if (!workout || state !== "tracking") return;
    if (progress.done) {
      if (!doneCuedRef.current) {
        doneCuedRef.current = true;
        armedDeadlineRef.current = null;
        cancelScheduledCue();
        playCue("done", t("tracker.guided.speak.done"), lang);
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
      lastCuedIdxRef.current = progress.idx;
      playCue("step", announceFor(step), lang);
      lastPaceCueRef.current = Date.now(); // fresh step — let pace settle
    }
    // Off-pace reminder, work steps only, throttled.
    const v = paceVerdict(step, stats.curPace);
    if ((v === "slow" || v === "fast")
      && stats.movingSec - progress.stepStartSec >= PACE_CUE_MIN_INTO_STEP_SEC
      && Date.now() - lastPaceCueRef.current >= PACE_CUE_EVERY_MS) {
      lastPaceCueRef.current = Date.now();
      playCue(v, t(v === "slow" ? "tracker.guided.speak.slow" : "tracker.guided.speak.fast"), lang);
    }
    // iOS: arm the native one-shot for a time boundary (a standing recovery
    // produces no fixes to wake JS). Distance boundaries need a fix by
    // definition, so nothing is armed for them. Never armed while muted —
    // scheduleCue would no-op but the drift guard would then block the re-arm
    // after unmute — and muting mid-step cancels the one already armed (the
    // `muted` dep re-runs this effect on every toggle).
    if (step.sec != null && !muted) {
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
  }, [workout, state, progress, stats, muted, announceFor, lang, t]);

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
    seedWorkoutGuide({
      steps: workout.steps.map(step => ({
        kind: step.kind,
        ...(step.m != null ? { m: step.m } : {}),
        ...(step.sec != null ? { sec: step.sec } : {}),
        ...(step.pace ? { pace: step.pace, band: step.band } : {}),
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
      muted,
      lang,
      texts: {
        notifTitle: t("tracker.guided.notifTitle"),
        done: t("tracker.guided.speak.done"),
        fast: t("tracker.guided.speak.fast"),
        slow: t("tracker.guided.speak.slow"),
      },
    });
  }, [workout, state, progress, muted, lang, announceFor, labelFor, detailFor, t]);

  // Tear down everything native on unmount (header go-Home mid-run).
  useEffect(() => () => {
    cancelScheduledCue();
    releaseCues();
    if (seededRef.current) clearWorkoutGuide();
  }, []);

  const toggleMute = useCallback(() => {
    setMuted(m => {
      setCuesMuted(!m);
      return !m;
    });
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
    return {
      step,
      label,
      detail,
      remaining: cur.done ? {} : stepRemaining(step, cur, stats),
      nextLabel: next ? [labelFor(next), detailFor(next)].filter(Boolean).join(" · ") : null,
      verdict: state === "tracking" && !cur.done ? paceVerdict(step, stats.curPace) : null,
      finished: cur.done,
      stepText: cur.done ? t("tracker.guided.doneShort") : [label, detail].filter(Boolean).join(" · "),
    };
  }, [workout, cur, stats, state, labelFor, detailFor, t]);

  return { guidable: !!compiled, active: !!workout, display, muted, toggleMute };
}
