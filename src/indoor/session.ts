import { registerPlugin } from "@capacitor/core";
import { isAndroid } from "../native";
import { t } from "../i18n";

// Holds the app process while an indoor session records — an indoor session
// runs no geo watch, so nothing else does (docs/indoor-sessions.md).
// Android-only and best-effort, like the HR journal.
//
// **Only while a live BLE strap is streaming**: the service is declared
// `connectedDevice`, so a strapless session must not claim the type — the
// recovery buffer and MainActivity's renderer restart cover that one.

const IndoorSession = registerPlugin<{
  start: (options: { startedAtMs: number; title: string; text: string }) => Promise<void>;
  stop: () => Promise<void>;
}>("IndoorSession");

export function startIndoorSessionService(startedAtMs: number | null): void {
  if (!isAndroid) return;
  IndoorSession.start({
    startedAtMs: startedAtMs || Date.now(),
    title: t("tracker.indoor.serviceTitle"),
    text: t("tracker.indoor.serviceText"),
  }).catch(() => { /* older shell / start refused — recording continues */ });
}

export function stopIndoorSessionService(): void {
  if (!isAndroid) return;
  IndoorSession.stop().catch(() => { /* best-effort */ });
}
