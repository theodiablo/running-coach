import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A single per-user jsonb blob with a whole-row upsert is unforgiving: the
// cache IS the next value of `data`. These tests pin the invariant that makes
// that safe — a cache we never successfully loaded is never written.

const h = vi.hoisted(() => {
  // Typed so `upsert.mock.calls[0][0]` is the upserted row, not `never`.
  const upsert = vi.fn<(row: { user_id: string; data: unknown }) => Promise<{ error: null }>>(
    async () => ({ error: null }),
  );
  const state: { result: { data: unknown; error: unknown } | Error } = {
    result: { data: { data: { rc_runs: ["real run"] } }, error: null },
  };
  return { upsert, state };
});

vi.mock("./supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (h.state.result instanceof Error) throw h.state.result;
            return h.state.result;
          },
        }),
      }),
      upsert: h.upsert,
    }),
  },
}));

import { db, initStore, clearStore, flushNow, isStoreLoaded, currentUserId } from "./db";
import { UNSYNCED_STATE_KEY } from "./constants";

const loadOk = (data: unknown, updatedAt?: string) => {
  h.state.result = { data: { data, ...(updatedAt ? { updated_at: updatedAt } : {}) }, error: null };
};
const loadErrors = () => { h.state.result = { data: null, error: { message: "boom" } }; };
const loadThrows = () => { h.state.result = new Error("network down"); };

// db.set debounces ~600ms; flushNow() only flushes when a write is pending.
const settle = async () => { await vi.advanceTimersByTimeAsync(700); };

describe("db store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    h.upsert.mockClear();
    h.upsert.mockImplementation(async () => ({ error: null }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    clearStore();
  });
  afterEach(() => {
    clearStore();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads the row and persists writes", async () => {
    loadOk({ rc_runs: ["real run"] });
    expect(await initStore("u1")).toBe(true);
    expect(isStoreLoaded()).toBe(true);
    expect(await db.get("rc_runs")).toEqual(["real run"]);

    await db.set("rc_plan", { weeks: [] });
    await settle();

    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.upsert.mock.calls[0][0]).toMatchObject({
      user_id: "u1",
      data: { rc_runs: ["real run"], rc_plan: { weeks: [] } },
    });
  });

  it("treats an absent row as a loaded, writable empty store (new user)", async () => {
    h.state.result = { data: null, error: null };
    expect(await initStore("new-user")).toBe(true);
    expect(isStoreLoaded()).toBe(true);

    await db.set("rc_settings", { onboarded: true });
    await settle();
    expect(h.upsert).toHaveBeenCalledTimes(1);
  });

  // The regression. A failed read used to fall back to `cache = {}` while
  // staying writable, so the first write replaced the user's runs and plan
  // with a blank slate.
  it("never writes after a failed read (PostgREST error)", async () => {
    loadErrors();
    expect(await initStore("u1")).toBe(false);
    expect(isStoreLoaded()).toBe(false);

    await db.set("rc_settings", { onboarded: true });
    await settle();
    await flushNow();

    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("never writes after a thrown read (offline / aborted fetch)", async () => {
    loadThrows();
    expect(await initStore("u1")).toBe(false);

    await db.set("rc_runs", []);
    await db.set("rc_plan", null);
    await settle();
    await flushNow();

    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("recovers on a successful retry and writes the real blob", async () => {
    loadThrows();
    expect(await initStore("u1")).toBe(false);
    await db.set("rc_settings", { onboarded: true });
    await settle();
    expect(h.upsert).not.toHaveBeenCalled();

    loadOk({ rc_runs: ["real run"], rc_plan: { weeks: [1] } });
    expect(await initStore("u1")).toBe(true);
    // The retry's blob wins; the write attempted while unloaded is gone, not
    // merged on top of a phantom empty state.
    expect(await db.get("rc_runs")).toEqual(["real run"]);
    expect(await db.get("rc_settings")).toBeNull();

    await db.set("rc_settings", { onboarded: true });
    await settle();
    expect(h.upsert.mock.calls[0][0]).toMatchObject({
      data: { rc_runs: ["real run"], rc_plan: { weeks: [1] }, rc_settings: { onboarded: true } },
    });
  });

  it("does not carry one account's cache onto another's row", async () => {
    loadOk({ rc_runs: ["user one run"] });
    await initStore("u1");

    // Second user's load fails: the cache must not still hold u1's runs, and
    // nothing may be written under u2.
    loadThrows();
    expect(await initStore("u2")).toBe(false);
    expect(currentUserId()).toBe("u2");
    expect(await db.get("rc_runs")).toBeNull();

    await db.set("rc_settings", { onboarded: true });
    await settle();
    await flushNow();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("stops writing once the store is cleared on sign-out", async () => {
    loadOk({ rc_runs: [] });
    await initStore("u1");
    clearStore();
    expect(isStoreLoaded()).toBe(false);

    await db.set("rc_runs", ["written while signed out"]);
    await settle();
    await flushNow();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("flushNow persists a pending write immediately", async () => {
    loadOk({});
    await initStore("u1");
    await db.set("rc_runs", ["pending"]);
    expect(h.upsert).not.toHaveBeenCalled();

    await flushNow();
    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.upsert.mock.calls[0][0]).toMatchObject({ data: { rc_runs: ["pending"] } });
  });
});

// A run saved offline used to live only in memory: the failed upsert was logged
// and forgotten, so killing the app before reconnecting lost the run for good
// (only its route trace survived, as an orphan). These pin the durability path:
// snapshot on every attempt, retry on reconnect/timer, restore on next boot.
describe("db store — offline durability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    h.upsert.mockClear();
    h.upsert.mockImplementation(async () => ({ error: null }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    clearStore();
  });
  afterEach(() => {
    clearStore();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps a snapshot after a failed flush and syncs it on reconnect", async () => {
    loadOk({});
    await initStore("u1");
    h.upsert.mockResolvedValueOnce({ error: { message: "offline" } as never });

    await db.set("rc_runs", ["saved offline"]);
    await settle();
    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(UNSYNCED_STATE_KEY)).toBeTruthy();

    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(10);
    expect(h.upsert).toHaveBeenCalledTimes(2);
    expect(h.upsert.mock.calls[1][0]).toMatchObject({ data: { rc_runs: ["saved offline"] } });
    expect(localStorage.getItem(UNSYNCED_STATE_KEY)).toBeNull();
  });

  it("retries a failed flush on its own timer", async () => {
    loadOk({});
    await initStore("u1");
    h.upsert.mockResolvedValueOnce({ error: { message: "offline" } as never });

    await db.set("rc_runs", ["saved offline"]);
    await settle();
    expect(h.upsert).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(h.upsert).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(UNSYNCED_STATE_KEY)).toBeNull();
  });

  it("restores a newer snapshot over the server row on boot, then re-flushes it", async () => {
    const now = Date.now();
    localStorage.setItem(UNSYNCED_STATE_KEY, JSON.stringify({
      userId: "u1", data: { rc_runs: ["offline run"] }, savedAt: now,
    }));
    loadOk({ rc_runs: ["server run"] }, new Date(now - 60_000).toISOString());

    expect(await initStore("u1")).toBe(true);
    expect(await db.get("rc_runs")).toEqual(["offline run"]);

    await settle();
    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.upsert.mock.calls[0][0]).toMatchObject({ data: { rc_runs: ["offline run"] } });
    expect(localStorage.getItem(UNSYNCED_STATE_KEY)).toBeNull();
  });

  it("drops a snapshot superseded by a newer server write (another device won)", async () => {
    const now = Date.now();
    localStorage.setItem(UNSYNCED_STATE_KEY, JSON.stringify({
      userId: "u1", data: { rc_runs: ["stale offline run"] }, savedAt: now - 120_000,
    }));
    loadOk({ rc_runs: ["server run"] }, new Date(now).toISOString());

    expect(await initStore("u1")).toBe(true);
    expect(await db.get("rc_runs")).toEqual(["server run"]);
    expect(localStorage.getItem(UNSYNCED_STATE_KEY)).toBeNull();
    await settle();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("leaves another account's snapshot untouched and unapplied", async () => {
    localStorage.setItem(UNSYNCED_STATE_KEY, JSON.stringify({
      userId: "u2", data: { rc_runs: ["u2's run"] }, savedAt: Date.now(),
    }));
    loadOk({ rc_runs: ["u1's run"] });

    expect(await initStore("u1")).toBe(true);
    expect(await db.get("rc_runs")).toEqual(["u1's run"]);
    expect(localStorage.getItem(UNSYNCED_STATE_KEY)).toBeTruthy(); // kept for u2's next sign-in
  });
});
