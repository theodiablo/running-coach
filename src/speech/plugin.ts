import { registerPlugin } from "@capacitor/core";

export type SpeechNative = {
  /** Whether this device actually has a usable recognizer. Never assume it. */
  available(): Promise<{ available: boolean }>;
  /** Prompts on first call. Resolves the granted state, never throws to kill the app. */
  requestPermission(): Promise<{ granted: boolean }>;
  start(opts: { lang: string }): Promise<void>;
  stop(): Promise<void>;
  addListener(
    event: "partial" | "final" | "error",
    cb: (data: { text?: string; message?: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
};

// Lazily resolve the native bridge, mirroring getWatchImportPlugin
// (src/watch/plugin.ts). registerPlugin returns a proxy whether or not the
// native half exists, so callers still gate on isNative + available().
let cached: SpeechNative | null = null;
export function getSpeechPlugin() {
  if (!cached) cached = registerPlugin<SpeechNative>("Speech");
  return cached;
}
