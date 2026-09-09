import { getSpeechPlugin } from "./plugin";
import type { SpeechHandlers, SpeechSource } from "./source";

// The device recognizer behind the Capacitor bridge: SpeechRecognizer on
// Android, SFSpeechRecognizer (requiresOnDeviceRecognition) on iOS. Both are
// free, OS-provided and on-device, so nothing said here leaves the phone.
//
// Every call is wrapped: an exception escaping a plugin coroutine kills the
// process outright, and a missing native half makes the proxy reject. A
// recognizer that can't start must degrade to "type it instead", never to a
// dead button — and never to a crash.
let removers: Array<() => Promise<void>> = [];

async function detach() {
  const pending = removers;
  removers = [];
  for (const remove of pending) {
    try { await remove(); } catch { /* listener already gone */ }
  }
}

export const nativeSpeechSource: SpeechSource = {
  async prepare(lang: string) {
    try {
      const plugin = getSpeechPlugin();
      const { available } = await plugin.available({ lang });
      if (!available) return false;
      const { granted } = await plugin.requestPermission();
      return granted;
    } catch {
      return false;
    }
  },

  async start(lang: string, handlers: SpeechHandlers) {
    const plugin = getSpeechPlugin();
    await detach();
    try {
      const listeners = await Promise.all([
        plugin.addListener("partial", d => handlers.onPartial(d.text ?? "")),
        plugin.addListener("final", d => handlers.onFinal(d.text ?? "")),
        plugin.addListener("error", d => handlers.onError(d.message ?? "speech_failed")),
      ]);
      removers = listeners.map(l => () => l.remove());
      await plugin.start({ lang });
    } catch (err) {
      await detach();
      handlers.onError(err instanceof Error ? err.message : "speech_failed");
    }
  },

  async stop() {
    try { await getSpeechPlugin().stop(); } catch { /* nothing was listening */ }
    await detach();
  },
};
