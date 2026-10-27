import { registerPlugin } from "@capacitor/core";
import { isAndroid } from "../native";
import { REC_NOTIF_ASKED_KEY } from "../constants";

// Request POST_NOTIFICATIONS (Android 13+) so the background-geolocation foreground
// service's ongoing "recording run" notification is visible while a run records
// with the screen off. Neither @capacitor/geolocation nor the background-geolocation
// plugin requests it, and without it Android 13+ silently suppresses the
// notification (the service still runs — recording is never affected).
//
// Backed by the local RunPermissions plugin (registerPlugin by name — its native
// code is discovered by `cap sync`; the web proxy just rejects, which the isAndroid
// gate below avoids). Android-only, never throws, never blocks recording.

type RunPermissionsNative = {
  checkNotifications: () => Promise<{ granted?: boolean }>;
  requestNotifications: () => Promise<{ granted?: boolean }>;
};

let cached: RunPermissionsNative | null = null;
function plugin(): RunPermissionsNative {
  if (!cached) cached = registerPlugin<RunPermissionsNative>("RunPermissions");
  return cached;
}

// Request the notification permission. Returns whether it's granted (always true
// off-Android and below Android 13, where no runtime permission exists).
export async function requestRunNotifications(): Promise<boolean> {
  if (!isAndroid) return true;
  try { return !!(await plugin().requestNotifications())?.granted; }
  catch { return false; }
}

// Null off-Android, where there is no runtime permission to show.
export async function checkRunNotifications(): Promise<boolean | null> {
  if (!isAndroid) return null;
  try { return !!(await plugin().checkNotifications())?.granted; }
  catch { return null; }
}

// Ask at most once per install (the first time a run starts), so a denial never
// re-nags on later runs — the user can still enable it from system settings.
// Fire-and-awaitable; a no-op after the first call or off-Android.
export async function requestRunNotificationsOnce(): Promise<void> {
  if (!isAndroid) return;
  let asked = false;
  try { asked = localStorage.getItem(REC_NOTIF_ASKED_KEY) === "1"; } catch { /* storage unavailable */ }
  if (asked) return;
  try { localStorage.setItem(REC_NOTIF_ASKED_KEY, "1"); } catch { /* storage unavailable — still ask */ }
  await requestRunNotifications();
}
