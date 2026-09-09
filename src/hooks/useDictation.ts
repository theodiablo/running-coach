import { useCallback, useEffect, useRef, useState } from "react";
import { getSpeechSource, type SpeechSession } from "../speech/source";
import { currentLocaleTag } from "../i18n";

type Options = {
  /** Settled text, to append to the field. Never sent anywhere on its own. */
  onText: (append: string) => void;
  /** Dictation could not start, or died mid-utterance. Always tell the user:
   *  a mic that does nothing reads as a broken app, not a missing permission. */
  onProblem: () => void;
};

// Dictation for a text field, shared by the coach composer and the feedback
// sheet. `supported` is false on the web build (getSpeechSource returns null
// there), which is what removes the mic button rather than any caller-side
// conditional.
//
// The settled text is APPENDED to whatever is already in the field and handed
// back to the caller — it is never sent anywhere on its own. A recognizer
// mishears names and paces constantly, so the transcript always lands in an
// editable field first and costs a tap to send, not a wasted daily message.
export function useDictation({ onText, onProblem }: Options) {
  // Deterministic and stable: getSpeechSource resolves off `isNative`, a
  // module constant, and returns a singleton — so this is safe to call every
  // render and the useCallback deps below never churn.
  const source = getSpeechSource();
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState("");
  const sessionRef = useRef<SpeechSession | null>(null);
  const mounted = useRef(true);
  const cb = useRef({ onText, onProblem });
  useEffect(() => { cb.current = { onText, onProblem }; });
  useEffect(() => () => { mounted.current = false; }, []);

  const stop = useCallback(async () => {
    await sessionRef.current?.stop();
  }, []);

  const start = useCallback(async () => {
    if (!source) return false;
    const lang = currentLocaleTag();
    if (!(await source.prepare(lang))) {
      cb.current.onProblem();
      return false;
    }
    setPartial("");
    setListening(true);
    const session = await source.start(lang, {
      onPartial: text => { if (mounted.current) setPartial(text); },
      onFinal: text => {
        if (text.trim()) cb.current.onText(text.trim());
      },
      // The session is over however it ended, so the mic state always resets
      // here. Without it a settled utterance leaves the UI claiming to listen
      // while the recognizer has already released the microphone.
      onEnd: reason => {
        if (mounted.current) { setListening(false); setPartial(""); }
        sessionRef.current = null;
        if (reason === "error") cb.current.onProblem();
      },
    });
    sessionRef.current = session;
    return session !== null;
  }, [source]);

  // A sheet closed mid-utterance must not leave the mic open.
  useEffect(() => () => { void sessionRef.current?.stop(); }, []);

  return { supported: source !== null, listening, partial, start, stop };
}
