// Pure content builder for the Android lock-screen run notification. The OS
// renders the ticking duration itself (chronometer anchored to moving time);
// JS only pushes content when distance/pace/HR changes — nothing here may
// depend on timers. i18n-free (returns a `titleKey`) so it's unit-testable.
// Details: docs/live-tracking.md.

import { fmt } from "./format";

export type RunNotificationInput = {
  state: "tracking" | "paused";
  km: number;
  /** Pace in sec/km — caller passes current pace with average as fallback. */
  paceSecPerKm: number;
  /** Latest live HR bpm, if a live sensor is streaming. */
  hr?: number | null;
  /** Moving time in ms (excludes pauses), computed from the tracker's refs. */
  movingMs: number;
  /** Wall clock now (ms) — passed in so the builder stays pure. */
  nowMs: number;
};

export type RunNotificationContent = {
  titleKey: "title" | "pausedTitle";
  message: string;
  /**
   * Chronometer anchor: the OS renders elapsed = now - chronometerStartMs.
   * Anchored to now - movingMs so the displayed clock is MOVING time (pauses
   * excluded), matching the in-app clock. Null while paused → static display.
   */
  chronometerStartMs: number | null;
};

// While tracking, the chronometer anchor is mathematically constant (now and
// movingMs advance together), so any drift between two pushes is rounding
// noise. Below this tolerance the anchor is treated as unchanged; a genuine
// re-anchor (resume after a pause shifts it by the pause's length) exceeds it.
const CHRONO_TOLERANCE_MS = 3000;

export function buildRunNotificationContent(input: RunNotificationInput): RunNotificationContent {
  const parts = [`${input.km.toFixed(2)} km`, `${fmt.pace(input.paceSecPerKm)}/km`];
  if (input.hr) parts.push(`♥ ${input.hr}`);
  if (input.state === "paused") {
    // No OS chronometer while paused — show the frozen moving time in the text.
    return {
      titleKey: "pausedTitle",
      message: [fmt.dur(Math.round(input.movingMs / 1000)), ...parts].join(" · "),
      chronometerStartMs: null,
    };
  }
  return {
    titleKey: "title",
    message: parts.join(" · "),
    chronometerStartMs: Math.round(input.nowMs - input.movingMs),
  };
}

// Change gate: true when posting `next` would not visibly change the
// notification, so the caller can skip the native call. Text must match
// exactly; the chronometer anchor tolerates rounding jitter (above).
export function sameNotificationContent(
  prev: RunNotificationContent | null | undefined,
  next: RunNotificationContent,
): boolean {
  if (!prev) return false;
  if (prev.titleKey !== next.titleKey || prev.message !== next.message) return false;
  if ((prev.chronometerStartMs == null) !== (next.chronometerStartMs == null)) return false;
  if (prev.chronometerStartMs == null || next.chronometerStartMs == null) return true;
  return Math.abs(prev.chronometerStartMs - next.chronometerStartMs) < CHRONO_TOLERANCE_MS;
}
