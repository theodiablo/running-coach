import { registerPlugin } from "@capacitor/core";
import { isAndroid } from "../native";
import type { StoredTrackPoint } from "../utils/geo";

// The native fix journal (Android, patched background-geolocation plugin): the
// foreground service appends every fix it accepts to a file on disk, so the
// points recorded while the WebView was frozen survive the process being killed
// — the localStorage recovery buffer only ever holds what JS saw, which stops
// at the last time the app was foregrounded. Read on recovery to extend the
// buffer (utils/runRecovery merges by timestamp); cleared when a run starts
// fresh or its recovery is resolved. Best-effort and Android-only: every call
// no-ops elsewhere and never throws.

// Same plugin name as src/geo/native.ts / liveNotification.ts — registerPlugin
// returns a proxy per call site; all address the one native instance.
const BackgroundGeolocation = registerPlugin<{
  getFixJournal: () => Promise<{ points?: unknown[] }>;
  clearFixJournal: () => Promise<void>;
}>("BackgroundGeolocation");

export async function readNativeFixJournal(): Promise<StoredTrackPoint[]> {
  if (!isAndroid) return [];
  try {
    const res = await BackgroundGeolocation.getFixJournal();
    return (res?.points || []).filter((p): p is StoredTrackPoint =>
      Array.isArray(p) && p.length >= 3
      && typeof p[0] === "number" && typeof p[1] === "number" && typeof p[2] === "number",
    ).map(p => [p[0], p[1], p[2], typeof p[3] === "number" ? p[3] : null]);
  } catch { return []; }
}

export function clearNativeFixJournal(): void {
  if (!isAndroid) return;
  BackgroundGeolocation.clearFixJournal().catch(() => { /* best-effort */ });
}
