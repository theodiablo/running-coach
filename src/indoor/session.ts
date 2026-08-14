import { registerPlugin } from "@capacitor/core";
import { isAndroid } from "../native";
import { t } from "../i18n";

// The foreground service that holds the app process while an indoor session
// records (docs/indoor-sessions.md), behind the same best-effort seam as the HR
// journal: Android-only, never throws, and a shell without the plugin simply
// resolves nothing.
//
// Why this exists: a GPS run is held by the background-geolocation plugin's
// location service, but an indoor session runs no geo watch, so nothing held
// the process — Android reclaimed the WebView renderer of a backgrounded
// session and left the recorder frozen on screen with every control dead.
//
// **Only while a live BLE strap is streaming.** The service is declared
// `connectedDevice`, which is honest precisely because the thing that has to
// survive is the GATT link to the sensor. A strapless session has no connected
// device and must not claim the type — it falls back to the recovery buffer and
// the renderer restart in MainActivity, which is what covers it.
//
// Copy is passed in from here rather than hardcoded natively so the notification
// follows the app's language.

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
