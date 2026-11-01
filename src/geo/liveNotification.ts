// Lock-screen live run stats: one JS contract, two native backends (Android service
// notification, iOS Live Activity). No-op on web, best-effort (never affects recording).
// A push is a SEED the service re-renders from while the WebView is frozen. Calls are
// serialized (end after in-flight) so a stale display can't resurrect: docs/live-tracking.md.

import { registerPlugin } from "@capacitor/core";
import { isAndroid, isIos } from "../native";
import { t } from "../i18n";
import { sameNotificationContent, type RunNotificationContent } from "../utils/runNotification";

type PushOptions = {
  title: string;
  message: string;
  // iOS only: guided-workout step line rendered by the Live Activity. Android's
  // step surface is the WorkoutGuide plugin's own notification instead.
  step?: string;
  chronometerStartMs?: number;
  // Android only (the patched plugin): the seed it re-renders distance/pace from
  // while the WebView is frozen in the background. iOS gets none of these.
  km?: number;
  elevM?: number;
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
// The patched Android plugin drops a live HR reading not refreshed in LIVE_HR_STALE_MS
// (90s). The bluetooth-le relay refreshes it natively; this keep-alive is the fallback,
// forcing a push at a shorter interval while HR is live so the text-identity dedupe
// can't age it out. A push never overwrites a fresher relayed beat.
const HR_KEEPALIVE_MS = 60000;

let lastSent: RunNotificationContent | null = null;
let lastApplied = false; // native confirmed the update landed
let lastAppliedAt = 0; // when that confirmation landed, for the HR keep-alive
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

// Text-identical to what's already confirmed applied, and (when HR is live)
// recent enough that the native HR seed can't have gone stale yet.
function alreadyApplied(content: RunNotificationContent): boolean {
  if (!lastApplied || !sameNotificationContent(lastSent, content)) return false;
  if (isAndroid && content.live.hr != null && Date.now() - lastAppliedAt >= HR_KEEPALIVE_MS) return false;
  return true;
}

function drain(): void {
  if (endPending) {
    endPending = false;
    runEnd();
    return; // a queued push (next run's first content) is sent when the end settles
  }
  if (queuedPush) {
    const content = queuedPush;
    queuedPush = null;
    if (!alreadyApplied(content)) sendNow(content);
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
    ...(isIos && content.step ? { step: content.step } : {}),
    ...(content.chronometerStartMs != null ? { chronometerStartMs: content.chronometerStartMs } : {}),
    ...(isAndroid ? {
      km: content.live.km,
      elevM: content.live.elevM,
      paceSecPerKm: content.live.paceSecPerKm,
      tracking: content.live.tracking,
      ...(content.live.hr ? { hr: content.live.hr, hrAtMs: content.live.hrAtMs ?? 0 } : {}),
    } : {}),
  };
  (isAndroid ? BackgroundGeolocation.updateNotification(options) : LiveActivity.push(options))
    .then((res) => {
      if (gen !== generation) return;
      lastApplied = res?.updated === true;
      if (lastApplied) lastAppliedAt = Date.now();
    })
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

/** Push run stats to the lock-screen surface: serialized, deduped against content the
 * native side CONFIRMED (so a refused push retries); Android re-pushes identical text
 * every HR_KEEPALIVE_MS while HR is live. Never throws. */
export function pushRunNotification(content: RunNotificationContent): void {
  if (!isAndroid && !isIos) return;
  if (inflightFresh()) {
    queuedPush = content; // latest wins; delivered when the in-flight call settles
    return;
  }
  if (alreadyApplied(content)) return;
  sendNow(content);
}

/** Run over: forget the dedupe state and end the iOS Live Activity. Ordered AFTER
 * any in-flight push so a late-settling push can't resurrect it. */
export function resetRunNotification(): void {
  lastSent = null;
  lastApplied = false;
  lastAppliedAt = 0;
  queuedPush = null;
  if (cleared) return;
  cleared = true;
  if (inflightFresh()) {
    endPending = true;
    return;
  }
  runEnd();
}
