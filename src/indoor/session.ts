import { registerPlugin } from "@capacitor/core";
import { isAndroid } from "../native";
import { t } from "../i18n";

// Holds the app process while an indoor session records (no geo watch, nothing else does;
// docs/indoor-sessions.md). Android-only, best-effort. **Only while a live BLE strap streams**: the
// service is `connectedDevice`, so a strapless session must not claim the type.

const IndoorSession = registerPlugin<{
  start: (options: { chronometerStartMs: number; title: string; text: string }) => Promise<void>;
  stop: () => Promise<void>;
}>("IndoorSession");

// `chronometerStartMs` anchors the OS-rendered clock, so it is now - movingMs —
// MOVING time, the same contract as the run notification's, or a resumed session
// reads ahead of the clock on screen.
export function startIndoorSessionService(chronometerStartMs: number): void {
  if (!isAndroid) return;
  IndoorSession.start({
    chronometerStartMs,
    title: t("tracker.indoor.serviceTitle"),
    text: t("tracker.indoor.serviceText"),
  }).catch(() => { /* older shell / start refused — recording continues */ });
}

export function stopIndoorSessionService(): void {
  if (!isAndroid) return;
  IndoorSession.stop().catch(() => { /* best-effort */ });
}
