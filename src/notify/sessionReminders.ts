import { LocalNotifications } from "@capacitor/local-notifications";
import { isNative, isAndroid } from "../native";
import { SESSION_NOTIF_AUTH_KEY } from "../constants";
import { requestRunNotifications } from "../geo/notifications";
import { reminderSchedule, type ReminderPrefs } from "../utils/sessionReminders";
import type { Plan } from "../types";

// Native seam for plan-session reminders. All the decisions live in the pure
// reminderSchedule (src/utils/sessionReminders.ts); this only talks to the OS.
// Mirrors src/geo/notifications.ts: native-gated, never throws, never blocks.
//
// Scheduling is deliberately INEXACT. A training reminder does not need
// minute precision, and SCHEDULE_EXACT_ALARM / USE_EXACT_ALARM invite a Play
// policy review for nothing.

const CHANNEL_ID = "session-reminders";
// Stamped on every reminder we schedule so cancelling only ever touches OUR
// notifications. Without it, turning reminders off would clear the whole
// pending queue, including anything a later feature schedules.
const KIND = "session-reminder";

const readMarker = (key: string) => {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
};
const writeMarker = (key: string, on: boolean) => {
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch { /* storage unavailable */ }
};

// Whether THIS install has the OS grant. The synced preference says the runner
// wants reminders; it says nothing about a permission on this particular phone,
// so the bridge is never touched without checking here first.
export const hasReminderGrant = () => readMarker(SESSION_NOTIF_AUTH_KEY);

// Ask the OS. Android reuses the POST_NOTIFICATIONS path already built for the
// run-recording notification; iOS prompts through the plugin.
export async function requestReminderPermission(): Promise<boolean> {
  if (!isNative) return false;
  try {
    const granted = isAndroid
      ? await requestRunNotifications()
      : (await LocalNotifications.requestPermissions()).display === "granted";
    writeMarker(SESSION_NOTIF_AUTH_KEY, granted);
    return granted;
  } catch {
    writeMarker(SESSION_NOTIF_AUTH_KEY, false);
    return false;
  }
}

async function ensureChannel(): Promise<void> {
  if (!isAndroid) return;
  try {
    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: "Training reminders",
      importance: 3,
      visibility: 1,
    });
  } catch { /* channel already exists, or the API is unavailable */ }
}

// Drop every reminder WE scheduled, leaving anything else pending alone.
async function cancelOurs(): Promise<void> {
  try {
    const pending = await LocalNotifications.getPending();
    const ours = pending.notifications.filter(n => n.extra?.kind === KIND);
    if (ours.length) await LocalNotifications.cancel({notifications: ours.map(n => ({id: n.id}))});
  } catch { /* nothing pending, or the bridge is unavailable */ }
}

// Recompute the whole pending set from the plan and hand it to the OS.
//
// Cancel-then-schedule rather than a diff: the plan is small, the scheduler is
// cheap, and a full replace is the only version that cannot leave a reminder
// behind for a session that was rebuilt, completed or deleted.
export async function syncSessionReminders(plan: Plan | null, prefs: ReminderPrefs): Promise<void> {
  if (!isNative) return;
  try {
    // Off, or not granted on this device: make sure nothing is left pending.
    if (!prefs.enabled || !hasReminderGrant()) { await cancelOurs(); return; }

    await ensureChannel();
    await cancelOurs();

    const due = reminderSchedule(plan, prefs, new Date());
    if (!due.length) return;

    await LocalNotifications.schedule({
      notifications: due.map(r => ({
        id: r.id,
        title: r.title,
        body: r.body,
        channelId: CHANNEL_ID,
        schedule: {at: r.at, allowWhileIdle: false},
        extra: {kind: KIND, sessionId: r.sessionId},
      })),
    });
  } catch { /* diagnostics only — a reminder must never break the app */ }
}

// Drop every pending reminder (opt-out, sign-out).
export async function clearSessionReminders(): Promise<void> {
  if (!isNative) return;
  await cancelOurs();
}
