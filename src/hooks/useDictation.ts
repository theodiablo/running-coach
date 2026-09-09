import { useCallback, useEffect, useRef, useState } from "react";
import { getSpeechSource } from "../speech/source";
import { currentLocaleTag } from "../i18n";

// Dictation for a text field, shared by the coach composer and the feedback
// sheet. `supported` is false on the web build (getSpeechSource returns null
// there), which is what removes the mic button rather than any caller-side
// conditional.
//
// The settled text is APPENDED to whatever is already in the field and handed
// back to the caller — it is never sent anywhere on its own. A recognizer
// mishears names and paces constantly, so the transcript always lands in an
// editable field first and costs a tap to send, not a wasted daily message.
export function useDictation(onText: (append: string) => void) {
  // Deterministic and stable: getSpeechSource resolves off `isNative`, a
  // module constant, and returns a singleton — so this is safe to call every
  // render and the useCallback deps below never churn.
  const source = getSpeechSource();
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState("");
  const onTextRef = useRef(onText);
  useEffect(() => { onTextRef.current = onText; });

  const stop = useCallback(async () => {
    if (!source) return;
    await source.stop();
    setListening(false);
    setPartial("");
  }, [source]);

  const start = useCallback(async () => {
    if (!source) return false;
    const lang = currentLocaleTag();
    if (!(await source.prepare(lang))) return false;
    setPartial("");
    setListening(true);
    await source.start(lang, {
      onPartial: setPartial,
      onFinal: text => {
        setPartial("");
        if (text.trim()) onTextRef.current(text.trim());
      },
      onError: () => { setListening(false); setPartial(""); },
    });
    return true;
  }, [source]);

  // A sheet closed mid-utterance must not leave the mic open.
  useEffect(() => () => { void source?.stop(); }, [source]);

  return { supported: source !== null, listening, partial, start, stop };
}
