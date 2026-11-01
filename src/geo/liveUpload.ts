// Native screen-off uploads: the JS→native seam (Android only). JS owns WHEN: enabled on
// visibilitychange→hidden mid-run with sharing on, disabled when JS is back (one writer at a
// time; docs/live-sharing.md). NOT routed through liveNotification's queue: a disable stranded
// behind a push would leave native appending to a paused run.

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
