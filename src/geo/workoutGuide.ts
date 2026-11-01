// Guided-workout native engine, JS to native seam (Android only). Android runs NO JS once backgrounded,
// so steps, callouts and HR warnings are evaluated natively off the LIVE_FIX relay (docs/live-tracking.md)
// and the plugin owns ALL cue audio (JS cues suppressed). JS stays the authority: every seed re-bases
// engine state, with pre-localized strings. Fire-and-forget, never throws: must never affect recording.

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
    say: { pace: boolean; hr: boolean; dist: boolean; left: "off" | "work" | "always" };
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
