import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { isAndroid, isIos, isNative } from "./native";
import { flushNow } from "./db";
import { APP_STORE_ID, PLAY_STORE_URL } from "./constants";

// The stores' own update and review UIs, through the local StoreBridge plugin
// (StoreBridgePlugin.kt / .swift). Every call is best-effort: a store that
// can't answer degrades to the app's own card, never to an error.
// docs/release.md ("Store prompts").

export type PlayInstallStatus =
  "pending" | "downloading" | "downloaded" | "installing" | "installed" | "failed" | "canceled" | "unknown";

export type PlayUpdateInfo = {
  available: boolean;
  inProgress: boolean;
  versionCode: number;
  stalenessDays: number;
  flexibleAllowed: boolean;
  immediateAllowed: boolean;
  status: PlayInstallStatus;
};

export type PlayInstallState = { status: PlayInstallStatus; bytesDownloaded: number; totalBytes: number };

type StoreBridgeNative = {
  getUpdateInfo: () => Promise<PlayUpdateInfo>;
  startUpdate: (o: { immediate: boolean }) => Promise<{ outcome?: "accepted" | "declined" | "failed" }>;
  completeUpdate: () => Promise<void>;
  requestReview: () => Promise<void>;
  openStorePage: (o: { appId?: string; review?: boolean }) => Promise<void>;
  getInstallInfo: () => Promise<InstallInfo>;
  addListener: (event: "updateState", cb: (s: PlayInstallState) => void) => Promise<PluginListenerHandle>;
};

const StoreBridge = registerPlugin<StoreBridgeNative>("StoreBridge");

/** What Play knows about an update for this install; null off Android or when Play can't answer (sideloaded, no Play). */
export async function playUpdateInfo(): Promise<PlayUpdateInfo | null> {
  if (!isAndroid) return null;
  try { return await StoreBridge.getUpdateInfo(); } catch { return null; }
}

/** Opens Play's update flow; null when Play refused or couldn't start it. */
export async function startPlayUpdate(immediate: boolean) {
  if (!isAndroid) return null;
  try { return (await StoreBridge.startUpdate({ immediate })).outcome ?? null; } catch { return null; }
}

/** Installs a downloaded flexible update. Play restarts the app, so pending writes go first. */
export async function completePlayUpdate() {
  if (!isAndroid) return;
  try { await flushNow(); } catch { /* the unsynced snapshot still holds them */ }
  try { await StoreBridge.completeUpdate(); } catch { /* the card stays; the next tap retries */ }
}

export function onPlayInstallState(cb: (s: PlayInstallState) => void): () => void {
  if (!isAndroid) return () => {};
  let handle: PluginListenerHandle | null = null;
  let gone = false;
  StoreBridge.addListener("updateState", cb)
    .then((h) => { if (gone) void h.remove(); else handle = h; })
    .catch(() => {});
  return () => { gone = true; void handle?.remove(); };
}

/** iOS: Apple's own review sheet (the only review prompt 5.6.1 allows). iOS decides whether it shows and never says. */
export async function requestStoreReview() {
  if (!isIos) return false;
  try { await StoreBridge.requestReview(); return true; } catch { return false; }
}

/** iOS: the App Store page in-app (TestFlight for a beta build). False when it couldn't open. */
export async function openAppStorePage() {
  if (!isIos) return false;
  try { await StoreBridge.openStorePage({ appId: APP_STORE_ID || undefined }); return true; } catch { return false; }
}

// `fromStore`: the store installed this copy (not sideloaded, debug, TestFlight
// or Xcode), so a review would be public. iOS adds its public listing, if any.
export type InstallInfo = { fromStore?: boolean; appId?: string; storeVersion?: string };

export async function installInfo(): Promise<InstallInfo> {
  if (!isNative) return {};
  try { return await StoreBridge.getInstallInfo(); } catch { return {}; }
}

// How this install may be asked for a review: Android shows the app's own Home
// card, iOS uses Apple's sheet (custom prompts are refused there). `link`: a
// write-a-review page exists for the Settings row.
export type ReviewChannel = { prompt: "card" | "native"; link: boolean };

/** Opens the store's write-a-review page. Android uses a plain top-frame navigation (docs/release.md). */
export async function openStoreReview() {
  if (isAndroid) {
    window.location.assign(PLAY_STORE_URL);
    return true;
  }
  if (!isIos) return false;
  try { await StoreBridge.openStorePage({ appId: APP_STORE_ID || undefined, review: true }); return true; } catch { return false; }
}
