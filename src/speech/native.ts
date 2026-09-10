import { getSpeechPlugin } from "./plugin";
import type { SpeechEndReason, SpeechHandlers, SpeechSession, SpeechSource } from "./source";

// The device recognizer behind the Capacitor bridge: SpeechRecognizer on
// Android, SFSpeechRecognizer (requiresOnDeviceRecognition) on iOS. Both are
// free, OS-provided and on-device, so nothing said here leaves the phone.
//
// Every call is wrapped: an exception escaping a plugin coroutine kills the
// process outright, and a missing native half makes the proxy reject. A
// recognizer that can't start must degrade to "type it instead", never to a
// dead button — and never to a crash.
//
// There is ONE microphone, so there is one session. The coach chat and the
// feedback sheet can be mounted together (the sheet opens over the chat), and
// each holds its own `useDictation`; a second `start` therefore supersedes the
// first and tells it so, rather than silently detaching its listeners and
// leaving it rendering a live mic over a dead recognizer.

type Session = {
  handlers: SpeechHandlers;
  removers: Array<() => Promise<void>>;
  ended: boolean;
};

let active: Session | null = null;

async function detach(session: Session) {
  const pending = session.removers;
  session.removers = [];
  for (const remove of pending) {
    try { await remove(); } catch { /* listener already gone */ }
  }
}

// Ends a session exactly once: later events for it are ignored, and no consumer
// ever sees a second onEnd.
function end(session: Session, reason: SpeechEndReason, message?: string) {
  if (session.ended) return;
  session.ended = true;
  if (active === session) active = null;
  void detach(session);
  session.handlers.onEnd(reason, message);
}

export const nativeSpeechSource: SpeechSource = {
  async prepare(lang: string) {
    try {
      const plugin = getSpeechPlugin();
      // Permission FIRST. iOS reports a recognizer as unavailable while its
      // authorization is still `notDetermined`, so asking about availability
      // before the prompt would hide the mic on every fresh install and the
      // usage-description strings would never be exercised.
      const { granted } = await plugin.requestPermission();
      if (!granted) return false;
      const { available } = await plugin.available({ lang });
      return available;
    } catch {
      return false;
    }
  },

  async start(lang: string, handlers: SpeechHandlers): Promise<SpeechSession | null> {
    const plugin = getSpeechPlugin();
    if (active) end(active, "superseded");

    const session: Session = { handlers, removers: [], ended: false };
    const live = () => active === session && !session.ended;

    try {
      const listeners = await Promise.all([
        plugin.addListener("partial", d => { if (live()) handlers.onPartial(d.text ?? ""); }),
        plugin.addListener("final", d => {
          if (!live()) return;
          const text = d.text ?? "";
          if (text) handlers.onFinal(text);
          // Both plugins release the recognizer once an utterance settles, so
          // the session is over even though nobody asked it to stop.
          end(session, "final");
        }),
        plugin.addListener("error", d => {
          if (live()) end(session, "error", d.message ?? "speech_failed");
        }),
      ]);
      session.removers = listeners.map(l => () => l.remove());
      active = session;
      await plugin.start({ lang });
    } catch (err) {
      active = null;
      session.ended = true;
      await detach(session);
      handlers.onEnd("error", err instanceof Error ? err.message : "speech_failed");
      return null;
    }

    return {
      stop: async () => {
        if (session.ended) return;
        try { await plugin.stop(); } catch { /* nothing was listening */ }
        end(session, "stopped");
      },
    };
  },
};
