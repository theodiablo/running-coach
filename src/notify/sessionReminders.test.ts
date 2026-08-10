import { describe, it, expect, beforeEach, vi } from "vitest";
import { SESSION_NOTIF_AUTH_KEY } from "../constants";
import type { Plan } from "../types";

// The seam is native-only, so the whole suite runs with isNative forced true —
// the web no-op is asserted separately at the bottom via a fresh module load.
vi.mock("../native", () => ({ isNative: true, isAndroid: true, isIos: false, platform: "android" }));
vi.mock("../geo/notifications", () => ({ requestRunNotifications: vi.fn(async () => true) }));

const schedule = vi.fn<(o: unknown) => Promise<void>>();
const cancel = vi.fn<(o: unknown) => Promise<void>>();
const getPending = vi.fn(async () => ({ notifications: [] as Array<Record<string, unknown>> }));
const createChannel = vi.fn<(o: unknown) => Promise<void>>();
const requestPermissions = vi.fn(async () => ({ display: "granted" }));
// The seam re-reads the live grant on every sync, so this drives "is it granted".
const checkPermissions = vi.fn(async () => ({ display: "granted" }));

vi.mock("@capacitor/local-notifications", () => ({
  LocalNotifications: { schedule, cancel, getPending, createChannel, requestPermissions, checkPermissions },
}));

const { syncSessionReminders, clearSessionReminders, hasReminderGrant, refreshReminderGrant } = await import("./sessionReminders");

const sess = (id: string, date: string, extra: Record<string, unknown> = {}) =>
  ({id, date, type: "EASY", desc: "Easy run 5km", km: 5, pace: 360, ...extra});

const plan = {weeks: [{weekNumber: 1, startDate: "2026-03-09", phase: "base", sessions: [
  sess("a", "2026-03-12"), sess("b", "2026-03-14"),
]}]} as unknown as Plan;

const ON = {enabled: true, time: "18:00", leadDays: 1 as const};
const OFF = {enabled: false, time: "18:00", leadDays: 1 as const};

// Two of ours, one belonging to something else entirely.
const pendingMix = [
  {id: 1, extra: {kind: "session-reminder", sessionId: "a"}},
  {id: 2, extra: {kind: "session-reminder", sessionId: "b"}},
  {id: 99, extra: {kind: "something-else"}},
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(new Date(2026, 2, 10, 9, 0));
  localStorage.clear();
  getPending.mockResolvedValue({ notifications: [] });
  checkPermissions.mockResolvedValue({ display: "granted" });
});

describe("turning reminders off", () => {
  it("cancels everything pending and schedules nothing", async () => {
    localStorage.setItem(SESSION_NOTIF_AUTH_KEY, "1");
    getPending.mockResolvedValue({ notifications: pendingMix });

    await syncSessionReminders(plan, OFF);

    expect(schedule).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith({notifications: [{id: 1}, {id: 2}]});
  });

  it("leaves notifications it did not schedule alone", async () => {
    localStorage.setItem(SESSION_NOTIF_AUTH_KEY, "1");
    getPending.mockResolvedValue({ notifications: pendingMix });

    await syncSessionReminders(plan, OFF);

    const cancelled = cancel.mock.calls[0][0] as unknown as {notifications: {id: number}[]};
    expect(cancelled.notifications.map(n => n.id)).not.toContain(99);
  });

  it("is a no-op rather than an error when nothing is pending", async () => {
    await syncSessionReminders(plan, OFF);
    expect(cancel).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("clearSessionReminders drops ours on demand", async () => {
    getPending.mockResolvedValue({ notifications: pendingMix });
    await clearSessionReminders();
    expect(cancel).toHaveBeenCalledWith({notifications: [{id: 1}, {id: 2}]});
  });
});

describe("the per-device grant gates the bridge", () => {
  it("schedules nothing when the preference is on but this device has no grant", async () => {
    // The synced preference arrived from the runner's other phone.
    checkPermissions.mockResolvedValue({ display: "denied" });
    getPending.mockResolvedValue({ notifications: pendingMix });
    expect(hasReminderGrant()).toBe(false);

    await syncSessionReminders(plan, ON);

    expect(schedule).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  });

  it("schedules once the grant is present on this install", async () => {
    localStorage.setItem(SESSION_NOTIF_AUTH_KEY, "1");
    await syncSessionReminders(plan, ON);

    expect(schedule).toHaveBeenCalledTimes(1);
    const arg = schedule.mock.calls[0][0] as unknown as {notifications: Array<Record<string, unknown>>};
    expect(arg.notifications).toHaveLength(2);
  });
});

describe("what gets scheduled", () => {
  beforeEach(() => localStorage.setItem(SESSION_NOTIF_AUTH_KEY, "1"));

  it("stamps every reminder so a later cancel can recognise it", async () => {
    await syncSessionReminders(plan, ON);
    const arg = schedule.mock.calls[0][0] as unknown as {notifications: Array<{extra: {kind: string}}>};
    expect(arg.notifications.every(n => n.extra.kind === "session-reminder")).toBe(true);
  });

  it("never asks for an exact alarm", async () => {
    await syncSessionReminders(plan, ON);
    const arg = schedule.mock.calls[0][0] as unknown as {notifications: Array<{schedule: {allowWhileIdle: boolean}}>};
    expect(arg.notifications.every(n => n.schedule.allowWhileIdle === false)).toBe(true);
  });

  it("puts them on their own Android channel, so the OS toggle mutes only these", async () => {
    await syncSessionReminders(plan, ON);
    expect(createChannel).toHaveBeenCalledWith(expect.objectContaining({id: "session-reminders"}));
    const arg = schedule.mock.calls[0][0] as unknown as {notifications: Array<{channelId: string}>};
    expect(arg.notifications.every(n => n.channelId === "session-reminders")).toBe(true);
  });

  it("clears the old set before scheduling the new one", async () => {
    getPending.mockResolvedValue({ notifications: pendingMix });
    await syncSessionReminders(plan, ON);
    expect(cancel).toHaveBeenCalled();
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(schedule.mock.invocationCallOrder[0]);
  });

  it("drops a session's reminder once it is marked done", async () => {
    const donePlan = {weeks: [{weekNumber: 1, startDate: "2026-03-09", phase: "base", sessions: [
      sess("a", "2026-03-12", {done: true}), sess("b", "2026-03-14"),
    ]}]} as unknown as Plan;

    await syncSessionReminders(donePlan, ON);
    const arg = schedule.mock.calls[0][0] as unknown as {notifications: Array<{extra: {sessionId: string}}>};
    expect(arg.notifications.map(n => n.extra.sessionId)).toEqual(["b"]);
  });

  it("schedules nothing for an empty plan, without throwing", async () => {
    await syncSessionReminders(null, ON);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("swallows a bridge failure rather than breaking the app", async () => {
    schedule.mockRejectedValueOnce(new Error("bridge unavailable"));
    await expect(syncSessionReminders(plan, ON)).resolves.toBeUndefined();
  });
});

describe("a revoked OS permission tears the schedule down", () => {
  it("cancels and stops scheduling once the OS says denied, even with the marker set", async () => {
    localStorage.setItem(SESSION_NOTIF_AUTH_KEY, "1");
    checkPermissions.mockResolvedValue({ display: "denied" });
    getPending.mockResolvedValue({ notifications: pendingMix });

    await syncSessionReminders(plan, ON);

    expect(schedule).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith({notifications: [{id: 1}, {id: 2}]});
  });

  it("refreshReminderGrant re-caches the live answer", async () => {
    localStorage.setItem(SESSION_NOTIF_AUTH_KEY, "1");
    checkPermissions.mockResolvedValue({ display: "denied" });

    await expect(refreshReminderGrant()).resolves.toBe(false);
    expect(hasReminderGrant()).toBe(false);
  });

  it("keeps the cached answer when the bridge check itself fails", async () => {
    localStorage.setItem(SESSION_NOTIF_AUTH_KEY, "1");
    checkPermissions.mockRejectedValueOnce(new Error("bridge unavailable"));
    await expect(refreshReminderGrant()).resolves.toBe(true);
  });
});

describe("overlapping syncs are serialised", () => {
  it("never lets an older sync's schedule land after a newer one's cancel", async () => {
    localStorage.setItem(SESSION_NOTIF_AUTH_KEY, "1");
    const order: string[] = [];
    cancel.mockImplementation(async () => { order.push("cancel"); });
    schedule.mockImplementation(async () => { order.push("schedule"); });
    getPending.mockResolvedValue({ notifications: pendingMix });

    // Fire both without awaiting the first — a plan edit landing while a
    // mark-as-done sync is still in flight.
    const a = syncSessionReminders(plan, ON);
    const b = syncSessionReminders(plan, ON);
    await Promise.all([a, b]);

    // Strict alternation proves no interleaving: each sync completed its
    // cancel+schedule pair before the next began.
    expect(order).toEqual(["cancel", "schedule", "cancel", "schedule"]);
    cancel.mockImplementation(async () => {});
    schedule.mockImplementation(async () => {});
  });
});

describe("web", () => {
  it("never touches the bridge at all", async () => {
    vi.resetModules();
    vi.doMock("../native", () => ({ isNative: false, isAndroid: false, isIos: false, platform: "web" }));
    const web = await import("./sessionReminders");

    localStorage.setItem(SESSION_NOTIF_AUTH_KEY, "1");
    await web.syncSessionReminders(plan, ON);
    await web.clearSessionReminders();

    expect(schedule).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(getPending).not.toHaveBeenCalled();
  });
});
