import { registerPlugin } from "@capacitor/core";
import { isAndroid } from "../native";
import { BG_LOC_ASKED_KEY } from "../constants";
import { logTrack } from "./trackLog";

// Request ACCESS_BACKGROUND_LOCATION ("Allow all the time") so live run tracking
// keeps receiving GPS fixes with the screen off / app backgrounded, rather than
// relying solely on the foreground service — which in practice stalls on some
// devices once the WebView is frozen (long screen-off holes in the recorded track).
//
// The permission is declared in the main manifest and shipped to all users (which
// requires the Google Play background-location declaration — see
// docs/background-location.md). The `declared` guard stays as defensive code: the
// native side reports declared:false and this becomes a no-op on any build/platform
// that does not declare it, so the app degrades to foreground-only rather than
// crashing. Backed by the local RunPermissions plugin (the same one that owns
// POST_NOTIFICATIONS). Android-only, never throws, never blocks recording.

type RunPermissionsBg = {
  checkBackgroundLocation: () => Promise<{ granted?: boolean; declared?: boolean }>;
  requestBackgroundLocation: () => Promise<{ granted?: boolean; declared?: boolean }>;
};

let cached: RunPermissionsBg | null = null;
function plugin(): RunPermissionsBg {
  if (!cached) cached = registerPlugin<RunPermissionsBg>("RunPermissions");
  return cached;
}

const markAsked = () => {
  try { localStorage.setItem(BG_LOC_ASKED_KEY, "1"); } catch { /* non-fatal */ }
};

// True on a build whose manifest declares ACCESS_BACKGROUND_LOCATION — now every
// Android build, since it ships to all users. The disclosure uses this to decide
// whether to show the "Allow all the time" step-by-step prompt guidance; it's false
// on web/iOS (no such permission), where that Android-specific copy shouldn't show.
export async function isBackgroundLocationAvailable(): Promise<boolean> {
  if (!isAndroid) return false;
  try { return !!(await plugin().checkBackgroundLocation())?.declared; }
  catch { return false; }
}

// Ask for background location at most once per install. On Android 11+ the OS
// routes this to a Settings screen (there is no in-context "Allow all the time"
// dialog), so re-asking on every run would be a nag — hence the once flag. Must be
// called only AFTER foreground fine location is granted (the caller guarantees it),
// which is the OS precondition for the background request to be offered at all.
export async function ensureBackgroundLocationOnce(): Promise<void> {
  if (!isAndroid) return;
  let asked = false;
  try { asked = localStorage.getItem(BG_LOC_ASKED_KEY) === "1"; } catch { /* storage unavailable */ }
  if (asked) return;
  try {
    const status = await plugin().checkBackgroundLocation();
    if (!status?.declared) return;                       // release build — not in the manifest; stay foreground-only
    if (status.granted) { logTrack("perm", { ok: true, msg: "bg-already" }); markAsked(); return; }
    const res = await plugin().requestBackgroundLocation();
    logTrack("perm", { ok: !!res?.granted, msg: "bg" });
    markAsked();
  } catch { /* plugin missing / web proxy rejected — non-fatal, stay foreground-only */ }
}

// Granted state for the readiness checklist: null where the permission doesn't
// exist (web, iOS, a build that doesn't declare it), so the row isn't shown.
export async function checkBackgroundLocation(): Promise<boolean | null> {
  if (!isAndroid) return null;
  try {
    const res = await plugin().checkBackgroundLocation();
    return res?.declared ? !!res.granted : null;
  } catch { return null; }
}

// An explicit tap from the readiness checklist: asks even if the once-per-install
// ask already ran, since the runner came here to fix it. Foreground location must
// already be granted (the checklist orders it so).
export async function requestBackgroundLocation(): Promise<boolean> {
  if (!isAndroid) return false;
  try {
    const res = await plugin().requestBackgroundLocation();
    markAsked();
    return !!res?.granted;
  } catch { return false; }
}
