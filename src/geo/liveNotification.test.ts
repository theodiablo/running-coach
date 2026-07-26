import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunNotificationContent } from "../utils/runNotification";

// Exercises the seam's native-call serialization on the iOS path (the one with
// an end() teardown, where the races are worst). The native plugin is mocked
// with manually-resolved deferreds so tests control exactly when a call
// settles; modules are re-imported per test because the seam keeps its queue
// state at module scope.

type Deferred = { resolve: (v: { updated?: boolean }) => void; reject: (e: unknown) => void };

const pushCalls: { options: { title: string; message: string; chronometerStartMs?: number }; deferred: Deferred }[] = [];
const endCalls: Deferred[] = [];

vi.mock("@capacitor/core", () => ({
  registerPlugin: (name: string) => {
    if (name === "LiveActivity") {
      return {
        push: (options: never) =>
          new Promise((resolve, reject) => { pushCalls.push({ options, deferred: { resolve, reject } }); }),
        end: () =>
          new Promise((resolve, reject) => { endCalls.push({ resolve: resolve as Deferred["resolve"], reject }); }),
      };
    }
    return { updateNotification: () => Promise.reject(new Error("wrong platform")) };
  },
}));
vi.mock("../native", () => ({ isAndroid: false, isIos: true }));
vi.mock("../i18n", () => ({ t: (k: string) => k }));

// The `live` seed only matters to the Android backend (asserted in
// liveNotification.android.test.ts); these iOS-path tests just carry one.
const live = { km: 5, paceSecPerKm: 300, hr: null, hrAtMs: null, tracking: true };
const tracking = (message: string): RunNotificationContent =>
  ({ titleKey: "title", message, chronometerStartMs: 1000, live });
const paused: RunNotificationContent =
  { titleKey: "pausedTitle", message: "30:00 · 5.00 km", chronometerStartMs: null, live: { ...live, tracking: false } };

// Let the seam's .then/.finally microtasks run.
const settle = () => new Promise((r) => { setTimeout(r, 0); });

let seam: typeof import("./liveNotification");

beforeEach(async () => {
  pushCalls.length = 0;
  endCalls.length = 0;
  vi.resetModules();
  seam = await import("./liveNotification");
});
afterEach(() => { vi.useRealTimers(); });

describe("pushRunNotification serialization", () => {
  it("queues content arriving mid-flight and delivers it after the call settles (pause must not be dropped)", async () => {
    seam.pushRunNotification(tracking("1.00 km"));
    expect(pushCalls).toHaveLength(1);

    // Pause lands while the tracking push is in flight — the old code dropped it.
    seam.pushRunNotification(paused);
    expect(pushCalls).toHaveLength(1);

    pushCalls[0].deferred.resolve({ updated: true });
    await settle();
    expect(pushCalls).toHaveLength(2);
    expect(pushCalls[1].options.title).toBe("tracker.notif.pausedTitle");
    expect(pushCalls[1].options.chronometerStartMs).toBeUndefined();
  });

  it("keeps only the latest queued content", async () => {
    seam.pushRunNotification(tracking("1.00 km"));
    seam.pushRunNotification(tracking("1.10 km"));
    seam.pushRunNotification(tracking("1.20 km"));
    pushCalls[0].deferred.resolve({ updated: true });
    await settle();
    expect(pushCalls).toHaveLength(2);
    expect(pushCalls[1].options.message).toBe("1.20 km");
  });

  it("retries content the native side did not confirm ({updated:false})", async () => {
    const content = tracking("0.00 km");
    seam.pushRunNotification(content);
    pushCalls[0].deferred.resolve({ updated: false });
    await settle();
    // Same content again (nothing changed on screen) — must re-send, not dedupe.
    seam.pushRunNotification(content);
    expect(pushCalls).toHaveLength(2);
  });
});

describe("resetRunNotification ordering", () => {
  it("defers end() until the in-flight push settles, so a late push cannot resurrect the activity", async () => {
    seam.pushRunNotification(tracking("5.00 km"));
    seam.resetRunNotification();
    expect(endCalls).toHaveLength(0); // not yet — push still in flight

    pushCalls[0].deferred.resolve({ updated: true });
    await settle();
    expect(endCalls).toHaveLength(1);
    expect(pushCalls).toHaveLength(1); // and nothing re-pushed after the end
  });

  it("ends immediately when idle, and only once per run", async () => {
    seam.pushRunNotification(tracking("5.00 km"));
    pushCalls[0].deferred.resolve({ updated: true });
    await settle();
    seam.resetRunNotification();
    seam.resetRunNotification(); // idempotent — the effect re-runs on stopped-state renders
    expect(endCalls).toHaveLength(1);
  });

  it("sweeps a stale card on the first reset after mount (crash recovery)", () => {
    seam.resetRunNotification();
    expect(endCalls).toHaveLength(1);
  });
});

describe("hang recovery", () => {
  it("writes off a call that never settles and keeps pushing", async () => {
    vi.useFakeTimers();
    seam.pushRunNotification(tracking("1.00 km"));
    expect(pushCalls).toHaveLength(1); // this one will hang forever

    vi.advanceTimersByTime(11_000); // past INFLIGHT_STALE_MS
    seam.pushRunNotification(tracking("2.00 km"));
    expect(pushCalls).toHaveLength(2); // not wedged — the hung call was written off
  });
});
