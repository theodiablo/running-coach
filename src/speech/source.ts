import { isNative } from "../native";
import { nativeSpeechSource } from "./native";

export type SpeechHandlers = {
  /** Interim hypothesis, replacing the previous one. Render it live. */
  onPartial: (text: string) => void;
  /** The recognizer's settled text for this utterance. */
  onFinal: (text: string) => void;
  onError: (message: string) => void;
};

export type SpeechSource = {
  /** Availability + permission, in one call. False means "offer typing".
   *  Locale-sensitive: iOS on-device models are per-language. */
  prepare(lang: string): Promise<boolean>;
  start(lang: string, handlers: SpeechHandlers): Promise<void>;
  stop(): Promise<void>;
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
