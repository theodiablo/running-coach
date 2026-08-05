// Native screen-off uploads — the JS→native seam (Android only).
//
// While the WebView is frozen (screen off), the LivePublish plugin's uploader
// POSTs accepted fixes to the live-publish edge function under the per-run
// publish token. JS owns WHEN it runs: it is enabled on visibilitychange→hidden
// mid-run with sharing on, and disabled the moment JS is back — one writer at a
// time, so the watcher's head marker can never snap backwards between a native
// raw append and a JS simplified full-trace write (docs/live-sharing.md).
//
// Deliberately NOT routed through liveNotification's serialization queue: a
// disable stranded behind an in-flight push as the screen goes off would leave
// native appending to a paused run. These calls go straight to the bridge.

import { registerPlugin } from "@capacitor/core";
import { isAndroid } from "../native";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config";

type LiveUploadOptions = {
  enabled: boolean;
  // Required when enabling; ignored on disable.
  url?: string;
  anonKey?: string;
  token?: string;
};

const LivePublish = registerPlugin<{
  setLiveUpload: (options: LiveUploadOptions) => Promise<void>;
}>("LivePublish");

/**
 * Arm the native uploader with this run's write capability. Fire-and-forget,
 * never throws — an upload seam failure must never affect recording.
 */
export function enableLiveUpload(token: string): void {
  if (!isAndroid) return;
  LivePublish.setLiveUpload({
    enabled: true,
    url: `${SUPABASE_URL}/functions/v1/live-publish`,
    anonKey: SUPABASE_ANON_KEY,
    token,
  }).catch(() => { /* best effort */ });
}

/** Disarm it (JS is back, or the run left the "tracking + sharing" state). */
export function disableLiveUpload(): void {
  if (!isAndroid) return;
  LivePublish.setLiveUpload({ enabled: false }).catch(() => { /* best effort */ });
}
