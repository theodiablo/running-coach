// Audio/haptic cue seam for guided workouts (docs/guided-workouts.md) — one JS
// contract, three backends:
//   web         — Web Audio beeps + speechSynthesis + vibrate (foreground only,
//                 which web recording already is);
//   iOS         — the AudioCue plugin (AVAudioSession playback with ducking, so
//                 cues land over the runner's music with the screen locked; a
//                 native `schedule` covers a time boundary that falls while no
//                 GPS fix wakes JS);
//   Android     — silent HERE on purpose: the WorkoutGuide plugin evaluates the
//                 whole schedule natively off the LIVE_FIX relay (fore AND
//                 background) and owns every sound, so a JS cue would double up.
// Whether to speak at all is the recorder's per-run audio switch: callers only
// call in when it's on, and the Android engine is told via its seed.
// Everything is fire-and-forget and never throws.

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
 * iOS only: arm a native one-shot cue for a time boundary `inMs` from now, so
 * "start again" still sounds when the screen is locked and no fix is waking
 * JS (a standing recovery emits none). Re-arming replaces the previous one.
 */
export function scheduleCue(inMs: number, tone: CueTone, text?: string, lang?: string): void {
  if (!isIos) return;
  AudioCue.schedule({ inMs, tone, ...(text ? { text, lang } : {}) }).catch(() => {});
}

export function cancelScheduledCue(): void {
  if (!isIos) return;
  AudioCue.cancelScheduled().catch(() => {});
}

/** Run over/reset: cancel anything pending and let go of the audio session. */
export function releaseCues(): void {
  if (isAndroid) return;
  if (isIos) { AudioCue.release().catch(() => {}); return; }
  stopWebSpeech();
}
