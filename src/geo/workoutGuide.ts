// Guided-workout native engine — the JS→native seam (Android only).
//
// Android runs NO JS once the app is backgrounded, so step boundaries, status
// callouts and heart-rate warnings must be evaluated natively while the screen
// is off. The
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
  hrLo?: number;
  hrHi?: number;
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
  /** Audio guidance off for this run (steps still advance, nothing is voiced). */
  muted: boolean;
  lang: string;
  /** Mirrors AudioPrefs (src/utils/callout.ts). */
  callout: {
    /** Seconds between status callouts; 0 = once per kilometre. */
    freqSec: number;
    say: { pace: boolean; hr: boolean; dist: boolean; left: boolean };
    /** bpm over the zone top before warning; -1 = never. */
    hrWarn: number;
  };
  decimalSep: string;
  /** Plural rule for spoken km: singular for every value below 2 (French), else only at 1. */
  kmOneBelowTwo: boolean;
  /** Pre-localized; {pace} {target} {bpm} {km} {n} {min} {sec} are filled natively. */
  texts: {
    notifTitle: string;
    done: string;
    pace: string;
    onPace: string;
    slowBy: string;
    fastBy: string;
    paceIs: string;
    heart: string;
    distDoneOne: string;
    distDoneOther: string;
    leftKmOne: string;
    leftKmOther: string;
    leftMOne: string;
    leftMOther: string;
    leftSecOne: string;
    leftSecOther: string;
    leftMinOther: string;
    hrHigh: string;
  };
};

const WorkoutGuide = registerPlugin<{
  seed: (options: GuideSeed) => Promise<void>;
  clear: () => Promise<void>;
  preview: (options: { text: string; lang: string }) => Promise<void>;
}>("WorkoutGuide");

/** Speak one sample callout through the native TTS (the sheet's "Hear it"). */
export function previewWorkoutGuide(text: string, lang: string): void {
  if (!isAndroid) return;
  WorkoutGuide.preview({ text, lang }).catch(() => { /* best effort */ });
}

export function seedWorkoutGuide(seed: GuideSeed): void {
  if (!isAndroid) return;
  WorkoutGuide.seed(seed).catch(() => { /* best effort */ });
}

export function clearWorkoutGuide(): void {
  if (!isAndroid) return;
  WorkoutGuide.clear().catch(() => { /* best effort */ });
}
