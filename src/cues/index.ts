// Audio/haptic cue seam for guided workouts (docs/guided-workouts.md): web (Web Audio, speech, vibrate),
// iOS (AudioCue plugin, ducking, native `schedule` for locked-screen boundaries), Android silent HERE
// (WorkoutGuide plugin owns every sound; a JS cue would double up; the stretch player has `stretchCue`).
// Callers only call in when the per-run audio switch is on. Fire-and-forget, never throws.

import { registerPlugin } from "@capacitor/core";
import { isAndroid, isIos } from "../native";
import { playWebTone, primeWebAudio, speakWeb, stopWebSpeech, vibrateWeb } from "./web";
import { previewWorkoutGuide } from "../geo/workoutGuide";

export type CueTone = "step" | "done" | "fast" | "slow" | "info";

type CueOptions = { tone: CueTone; text?: string; lang?: string };

const AudioCue = registerPlugin<{
  prime: () => Promise<void>;
  play: (options: CueOptions) => Promise<void>;
  schedule: (options: CueOptions & { inMs: number }) => Promise<void>;
  cancelScheduled: () => Promise<void>;
  release: () => Promise<void>;
}>("AudioCue");

/** Call from the Start tap (a user gesture): unlocks web audio / the iOS session. */
export function primeCues(): void {
  if (isAndroid) return;
  if (isIos) { AudioCue.prime().catch(() => {}); return; }
  primeWebAudio();
}

/** Play a cue now: tone + optional spoken text. No-op on Android (native owns). */
export function playCue(tone: CueTone, text?: string, lang?: string): void {
  if (isAndroid) return;
  if (isIos) {
    AudioCue.play({ tone, ...(text ? { text, lang } : {}) }).catch(() => {});
    return;
  }
  playWebTone(tone);
  if (text) speakWeb(text, lang || "en");
  vibrateWeb(tone === "done" ? [180, 90, 180] : [120]);
}

/** A sample callout from a settings tap (a user gesture), on every platform. */
export function previewCue(text: string, lang: string): void {
  if (isAndroid) { previewWorkoutGuide(text, lang); return; }
  primeCues();
  if (isIos) { AudioCue.play({ tone: "info", text, lang }).catch(() => {}); return; }
  playWebTone("info");
  speakWeb(text, lang);
}

/**
 * iOS only: arm a native one-shot cue `inMs` from now so it sounds with the screen locked and no
 * fix waking JS. Re-arming replaces the previous one.
 */
export function scheduleCue(inMs: number, tone: CueTone, text?: string, lang?: string): void {
  if (!isIos) return;
  AudioCue.schedule({ inMs, tone, ...(text ? { text, lang } : {}) }).catch(() => {});
}

export function cancelScheduledCue(): void {
  if (!isIos) return;
  AudioCue.cancelScheduled().catch(() => {});
}

/** The stretch player's prime, from its Start tap. Unlike `primeCues` it primes Web Audio on Android too. */
export function primeStretchCues(): void {
  if (isIos) { AudioCue.prime().catch(() => {}); return; }
  primeWebAudio();
}

/**
 * A stretch player cue. The player is a foreground timer with no native engine
 * behind it, so Android beeps through Web Audio and speaks through the guide's TTS.
 */
export function stretchCue(tone: CueTone, text?: string, lang = "en"): void {
  if (isIos) {
    AudioCue.play({ tone, ...(text ? { text, lang } : {}) }).catch(() => {});
    return;
  }
  playWebTone(tone);
  if (!text) return;
  if (isAndroid) { previewWorkoutGuide(text, lang); return; }
  // speechSynthesis queues: a skip must replace the announcement, not wait behind it.
  stopWebSpeech();
  speakWeb(text, lang);
}

/** Run over/reset: cancel anything pending and let go of the audio session. */
export function releaseCues(): void {
  if (isAndroid) return;
  if (isIos) { AudioCue.release().catch(() => {}); return; }
  stopWebSpeech();
}
