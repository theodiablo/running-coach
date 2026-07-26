// Lock-screen live run stats — one JS contract, two native backends (Android
// foreground-service notification, iOS Live Activity). No-op on web,
// best-effort (a display failure must never affect recording). A push is a
// SEED, not the only update: Android's WebView is frozen while the app is
// backgrounded, so the foreground service keeps re-rendering distance/pace from
// the last seed until JS runs again. Calls are
// serialized (queued, end ordered after in-flight) to avoid a paused/ended
// run resurrecting a stale native display. Details: docs/live-tracking.md.

import { registerPlugin } from "@capacitor/core";
import { isAndroid, isIos } from "../native";
import { t } from "../i18n";
import { sameNotificationContent, type RunNotificationContent } from "../utils/runNotification";

type PushOptions = {
  title: string;
  message: string;
  chronometerStartMs?: number;
  // Android only (the patched plugin): the seed it re-renders distance/pace from
  // while the WebView is frozen in the background. iOS gets none of these.
  km?: number;
  paceSecPerKm?: number;
  hr?: number;
  hrAtMs?: number;
  tracking?: boolean;
};
type PushResult = { updated?: boolean };

// Same plugin name as src/geo/native.ts — registerPlugin returns a proxy per
// call site; both address the one native instance.
const BackgroundGeolocation = registerPlugin<{
  updateNotification: (options: PushOptions) => Promise<PushResult>;
}>("BackgroundGeolocation");

const LiveActivity = registerPlugin<{
  push: (options: PushOptions) => Promise<PushResult>;
  end: () => Promise<void>;
}>("LiveActivity");

const INFLIGHT_STALE_MS = 10000;

let lastSent: RunNotificationContent | null = null;
let lastApplied = false; // native confirmed the update landed
let inflight = false;
let inflightSince = 0;
let generation = 0; // invalidates the settle-handler of a written-off (stale) call
let queuedPush: RunNotificationContent | null = null; // latest content awaiting the in-flight call
let endPending = false; // an end() ordered behind the in-flight call
// False once something was pushed; resetRunNotification flips it back and (on
// iOS) ends the Live Activity exactly once per run — including a stale card
// left behind by a crashed session, swept by the first reset after mount.
let cleared = false;

const inflightFresh = () => inflight && Date.now() - inflightSince < INFLIGHT_STALE_MS;

function drain(): void {
  if (endPending) {
    endPending = false;
    runEnd();
    return; // a queued push (next run's first content) is sent when the end settles
  }
  if (queuedPush) {
    const content = queuedPush;
    queuedPush = null;
    if (!(lastApplied && sameNotificationContent(lastSent, content))) sendNow(content);
  }
}

function sendNow(content: RunNotificationContent): void {
  const gen = ++generation; // a write-off (stale hang) supersedes this handler
  inflight = true;
  inflightSince = Date.now();
  cleared = false;
  lastSent = content;
  const options: PushOptions = {
    title: t(`tracker.notif.${content.titleKey}`),
    message: content.message,
    ...(content.chronometerStartMs != null ? { chronometerStartMs: content.chronometerStartMs } : {}),
    ...(isAndroid ? {
      km: content.live.km,
      paceSecPerKm: content.live.paceSecPerKm,
      tracking: content.live.tracking,
      ...(content.live.hr ? { hr: content.live.hr, hrAtMs: content.live.hrAtMs ?? 0 } : {}),
    } : {}),
  };
  (isAndroid ? BackgroundGeolocation.updateNotification(options) : LiveActivity.push(options))
    .then((res) => { if (gen === generation) lastApplied = res?.updated === true; })
    .catch(() => { if (gen === generation) lastApplied = false; })
    .finally(() => { if (gen === generation) { inflight = false; drain(); } });
}

function runEnd(): void {
  // Android has nothing to end (the watcher removal clears the notification);
  // still route through the queue so a trailing queued push drains in order.
  const gen = ++generation;
  inflight = true;
  inflightSince = Date.now();
  (isIos ? LiveActivity.end() : Promise.resolve())
    .catch(() => { /* best-effort */ })
    .finally(() => { if (gen === generation) { inflight = false; drain(); } });
}

/**
 * Push run stats to the platform's lock-screen surface. Serialized behind any
 * in-flight native call (latest content wins), deduped against the last
 * content the native side CONFIRMED (`updated: true`) — so a push that raced
 * ahead of the watcher/service (Android) or was refused (iOS) is retried on
 * the next call instead of being silently lost. Fire-and-forget; never throws.
 */
export function pushRunNotification(content: RunNotificationContent): void {
  if (!isAndroid && !isIos) return;
  if (inflightFresh()) {
    queuedPush = content; // latest wins; delivered when the in-flight call settles
    return;
  }
  if (lastApplied && sameNotificationContent(lastSent, content)) return;
  sendNow(content);
}

/**
 * Run over — forget the dedupe state and tear down the iOS Live Activity.
 * Ordered AFTER any in-flight push so a push settling late can't resurrect
 * the activity for a run that already ended.
 */
export function resetRunNotification(): void {
  lastSent = null;
  lastApplied = false;
  queuedPush = null;
  if (cleared) return;
  cleared = true;
  if (inflightFresh()) {
    endPending = true;
    return;
  }
  runEnd();
}
