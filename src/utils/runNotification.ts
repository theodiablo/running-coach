// Pure content builder for the Android lock-screen run notification. The OS
// renders the ticking duration itself (chronometer anchored to moving time);
// JS only pushes content when distance/pace/HR changes — nothing here may
// depend on timers. i18n-free (returns a `titleKey`) so it's unit-testable.
// Every push also carries a `live` seed, from which the Android foreground
// service re-renders distance/pace on its own while the WebView is frozen in
// the background. Details: docs/live-tracking.md.

import { fmt } from "./format";

export type RunNotificationInput = {
  state: "tracking" | "paused";
  km: number;
  /** Pace in sec/km — caller passes current pace with average as fallback. */
  paceSecPerKm: number;
  /** Latest live HR bpm, if a live sensor is streaming. */
  hr?: number | null;
  /** Epoch ms of that HR sample — the native renderer drops a stale reading. */
  hrAt?: number | null;
  /** Moving time in ms (excludes pauses), computed from the tracker's refs. */
  movingMs: number;
  /** Wall clock now (ms) — passed in so the builder stays pure. */
  nowMs: number;
  /**
   * Guided-workout current step ("Rep 3/6 · 800 m · 4:35/km"), pre-localized.
   * iOS-only display (Live Activity step line): Android's step surface is the
   * WorkoutGuide plugin's own notification, and the patched service rebuilds
   * `message` natively — a step suffix there would flicker away on the first
   * background fix.
   */
  stepText?: string | null;
};

/**
 * What the Android foreground service needs to keep the message live by itself:
 * the authoritative distance/pace as of this push, the latest HR reading, and
 * whether fixes should still be counted. The service adds the distance of every
 * fix that lands after the push (same filters as the tracker) on top of `km`,
 * so the two ends never disagree — see docs/live-tracking.md. Android-only, and
 * NOT display state: `sameNotificationContent` ignores it.
 */
export type RunNotificationLive = {
  km: number;
  paceSecPerKm: number;
  hr: number | null;
  hrAtMs: number | null;
  tracking: boolean;
};

export type RunNotificationContent = {
  titleKey: "title" | "pausedTitle";
  message: string;
  /** Guided-workout step line (iOS Live Activity); absent when unguided. */
  step?: string;
  /**
   * Chronometer anchor: the OS renders elapsed = now - chronometerStartMs.
   * Anchored to now - movingMs so the displayed clock is MOVING time (pauses
   * excluded), matching the in-app clock. Null while paused → static display.
   */
  chronometerStartMs: number | null;
  live: RunNotificationLive;
};

// While tracking, the chronometer anchor is mathematically constant (now and
// movingMs advance together), so any drift between two pushes is rounding
// noise. Below this tolerance the anchor is treated as unchanged; a genuine
// re-anchor (resume after a pause shifts it by the pause's length) exceeds it.
const CHRONO_TOLERANCE_MS = 3000;

export function buildRunNotificationContent(input: RunNotificationInput): RunNotificationContent {
  const parts = [`${input.km.toFixed(2)} km`, `${fmt.pace(input.paceSecPerKm)}/km`];
  if (input.hr) parts.push(`♥ ${input.hr}`);
  const live: RunNotificationLive = {
    km: input.km,
    paceSecPerKm: input.paceSecPerKm,
    hr: input.hr || null,
    hrAtMs: input.hrAt || null,
    tracking: input.state === "tracking",
  };
  const step = input.stepText ? { step: input.stepText } : {};
  if (input.state === "paused") {
    // No OS chronometer while paused — show the frozen moving time in the text.
    return {
      titleKey: "pausedTitle",
      message: [fmt.dur(Math.round(input.movingMs / 1000)), ...parts].join(" · "),
      ...step,
      chronometerStartMs: null,
      live,
    };
  }
  return {
    titleKey: "title",
    message: parts.join(" · "),
    ...step,
    chronometerStartMs: Math.round(input.nowMs - input.movingMs),
    live,
  };
}

// Change gate: true when posting `next` would not visibly change the
// notification, so the caller can skip the native call. Text must match
// exactly; the chronometer anchor tolerates rounding jitter (above). The `live`
// seed is deliberately not compared — identical text means identical numbers
// (km is in the text to 2dp), so a skipped push can't leave the seed stale.
export function sameNotificationContent(
  prev: RunNotificationContent | null | undefined,
  next: RunNotificationContent,
): boolean {
  if (!prev) return false;
  if (prev.titleKey !== next.titleKey || prev.message !== next.message) return false;
  if ((prev.step || null) !== (next.step || null)) return false;
  if ((prev.chronometerStartMs == null) !== (next.chronometerStartMs == null)) return false;
  if (prev.chronometerStartMs == null || next.chronometerStartMs == null) return true;
  return Math.abs(prev.chronometerStartMs - next.chronometerStartMs) < CHRONO_TOLERANCE_MS;
}
