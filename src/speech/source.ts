import { isNative } from "../native";
import { nativeSpeechSource } from "./native";

/** Why a dictation session ended. Always delivered exactly once. */
export type SpeechEndReason =
  | "final"       // the recognizer settled an utterance and released the mic
  | "stopped"     // the caller stopped it
  | "error"       // the recognizer failed
  | "superseded"; // another surface started dictating

export type SpeechHandlers = {
  /** Interim hypothesis, replacing the previous one. Render it live. */
  onPartial: (text: string) => void;
  /** The recognizer's settled text for this utterance. */
  onFinal: (text: string) => void;
  /** Last call for this session, whatever ended it. The mic is closed by now,
   *  so a consumer that does not clear its "listening" state here will show a
   *  live mic over a dead recognizer. */
  onEnd: (reason: SpeechEndReason, message?: string) => void;
};

/** One dictation session. Stopping a session that already ended is a no-op. */
export type SpeechSession = { stop: () => Promise<void> };

export type SpeechSource = {
  /** Permission + availability, in one call. False means "offer typing".
   *  Locale-sensitive: iOS on-device models are per-language. */
  prepare(lang: string): Promise<boolean>;
  /** Starts listening. Null means it could not start; `onEnd` is not called in
   *  that case, because no session began. */
  start(lang: string, handlers: SpeechHandlers): Promise<SpeechSession | null>;
};

// Resolve the dictation source, or null where there isn't one. Mirrors
// getHrSource (src/hr/source.ts) and geoSource: speech is NATIVE-ONLY, so the
// web build always gets null and behaves exactly as it did before.
//
// Deliberately no web backend. Chrome's webkitSpeechRecognition is not local —
// it streams microphone audio to Google — so shipping it would mean a second,
// weaker privacy sentence for one platform, and Firefox has no implementation
// at all. Null is the whole fallback mechanism: the mic button renders only
// when a source exists, so no caller needs a conditional of its own.
export function getSpeechSource(): SpeechSource | null {
  return isNative ? nativeSpeechSource : null;
}
