// Guided-workout native engine — the JS→native seam (Android only).
//
// Android runs NO JS once the app is backgrounded, so step boundaries and
// pace cues must be evaluated natively while the screen is off. The
// WorkoutGuide plugin consumes the same LIVE_FIX relay as LivePublish (one
// native fold, shared consumers — docs/live-tracking.md) for distance/pace,
// runs its own Handler deadline for time-bound steps, and owns ALL cue audio
// on Android (JS cues are suppressed there — see src/cues). JS stays the
// authority: every seed re-bases the whole engine state (step index, step
// anchors, cumulative km / moving sec), so the two ends can drift at most one
// boundary between seeds, and the next foreground render snaps them together.
// Seeds carry pre-localized strings — the service can't reach i18n.
// Fire-and-forget, never throws: a guide failure must never affect recording.

import { registerPlugin } from "@capacitor/core";
import { isAndroid } from "../native";

export type GuideSeedStep = {
  kind: string;
  m?: number;
  sec?: number;
  pace?: number;
  band?: number;
  /** Spoken on entering the step (pre-localized). */
  announce: string;
  /** Short notification line for the step (pre-localized). */
  notif: string;
};

export type GuideSeed = {
  steps: GuideSeedStep[];
  loopFrom?: number;
  /** Engine state as of this seed (JS authoritative). */
  idx: number;
  stepStartKm: number;
  stepStartSec: number;
  km: number;
  movingSec: number;
  tracking: boolean;
  finished: boolean;
  muted: boolean;
  lang: string;
  texts: {
    notifTitle: string;
    done: string;
    fast: string;
    slow: string;
  };
};

const WorkoutGuide = registerPlugin<{
  seed: (options: GuideSeed) => Promise<void>;
  clear: () => Promise<void>;
}>("WorkoutGuide");

export function seedWorkoutGuide(seed: GuideSeed): void {
  if (!isAndroid) return;
  WorkoutGuide.seed(seed).catch(() => { /* best effort */ });
}

export function clearWorkoutGuide(): void {
  if (!isAndroid) return;
  WorkoutGuide.clear().catch(() => { /* best effort */ });
}
