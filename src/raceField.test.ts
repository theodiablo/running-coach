// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A chainable supabase stub that records every call and resolves with `h.next`.
const h = vi.hoisted(() => ({ calls: [] as unknown[][], results: [] as { data?: unknown; error?: unknown }[] }));

vi.mock("./supabase", () => {
  const chain = (): Record<string, unknown> => {
    const self: Record<string, unknown> = {};
    for (const m of ["select", "insert", "update", "delete", "eq", "in", "not", "maybeSingle"]) {
      self[m] = (...args: unknown[]) => { h.calls.push([m, ...args]); return self; };
    }
    self.then = (resolve: (v: unknown) => void) => resolve(h.results.shift() ?? { data: null, error: null });
    return self;
  };
  return {
    supabase: {
      from: (table: string) => { h.calls.push(["from", table]); return chain(); },
      rpc: (fn: string, args: unknown) => { h.calls.push(["rpc", fn, args]); return chain(); },
    },
  };
});

const { fetchRaceField, setFieldChoice, syncFieldGoal, noteListedEditions, pendingLeaves, leavePendingFields, createFieldReconciler } = await import("./raceField");
const ops = () => h.calls.map(c => c[0]);

beforeEach(() => { h.calls = []; h.results = []; });

describe("fetchRaceField", () => {
  it("reads an open field", async () => {
    h.results.push({ data: { open: true, joined: true, count: 9 }, error: null });
    expect(await fetchRaceField("e1")).toEqual({ open: true, joined: true, count: 9 });
    expect(h.calls[0]).toEqual(["rpc", "race_field", { p_edition_id: "e1" }]);
  });

  it("reads the closed shape as closed with no count", async () => {
    h.results.push({ data: { open: false, joined: false }, error: null });
    expect(await fetchRaceField("e1")).toEqual({ open: false, joined: false, count: null });
  });

  it("returns null on a failed read, never a closed-and-not-joined answer", async () => {
    h.results.push({ data: null, error: { message: "boom" } });
    expect(await fetchRaceField("e1")).toBeNull();
  });
});

describe("setFieldChoice", () => {
  it("inserts a new membership, never upserts", async () => {
    expect(await setFieldChoice("u", "e1", "named", 6300, null)).toBe("ok");
    expect(ops()).toEqual(["from", "insert"]);
    expect(h.calls[1][1]).toEqual({ user_id: "u", edition_id: "e1", visibility: "named", goal_sec: 6300 });
  });

  it("updates an existing one, with only the mutable columns", async () => {
    h.results.push({ data: [{ edition_id: "e1" }], error: null });
    expect(await setFieldChoice("u", "e1", "count", 6300, { visibility: "named", goalSec: 6300 })).toBe("ok");
    expect(ops()).toEqual(["from", "update", "eq", "eq", "select"]);
    expect(h.calls[1][1]).toEqual({ visibility: "count", goal_sec: null });
  });

  it("deletes on Not this time, and writes nothing when there was no row", async () => {
    expect(await setFieldChoice("u", "e1", "none", null, { visibility: "count", goalSec: null })).toBe("ok");
    expect(ops()).toEqual(["from", "delete", "eq", "eq"]);
    h.calls = [];
    expect(await setFieldChoice("u", "e1", "none", null, null)).toBe("ok");
    expect(h.calls).toEqual([]);
  });

  it("turns a duplicate join into a change, when the runner is already a member", async () => {
    h.results.push({ error: { code: "23505", message: "duplicate key" } }, { data: [{ edition_id: "e1" }], error: null });
    expect(await setFieldChoice("u", "e1", "named", 6300, null)).toBe("ok");
    expect(ops()).toEqual(["from", "insert", "from", "update", "eq", "eq", "select"]);
  });

  it("maps the guard trigger's refusals", async () => {
    h.results.push({ error: { message: "race field limit reached" } });
    expect(await setFieldChoice("u", "e1", "count", null, null)).toBe("limit");
    h.results.push({ error: { message: "race field closed" } });
    expect(await setFieldChoice("u", "e1", "count", null, null)).toBe("closed");
    h.results.push({ error: { message: "network" } });
    expect(await setFieldChoice("u", "e1", "count", null, null)).toBe("error");
  });
});

describe("syncFieldGoal", () => {
  it("only touches a goal already shown, so a hidden one stays hidden", async () => {
    await syncFieldGoal("u", "e1", 6000);
    expect(h.calls).toContainEqual(["eq", "visibility", "named"]);
    expect(h.calls).toContainEqual(["not", "goal_sec", "is", null]);
  });
});

describe("pending leaves", () => {
  beforeEach(() => { localStorage.clear(); });

  it("deletes only races this device saw leave the list", async () => {
    noteListedEditions("u", [], ["a", "b"]);
    noteListedEditions("u", ["b"], ["a"]);
    expect(pendingLeaves("u")).toEqual(["b"]);
    expect(await leavePendingFields("u", () => ["a"])).toBe(true);
    expect(h.calls.find(c => c[0] === "in")).toEqual(["in", "edition_id", ["b"]]);
    expect(pendingLeaves("u")).toEqual([]);
  });

  it("never deletes a membership it has no record of removing", async () => {
    expect(await leavePendingFields("u", () => [])).toBe(true);
    expect(ops()).not.toContain("delete");
  });

  it("keeps a race re-added before the delete runs", async () => {
    noteListedEditions("u", ["b"], []);
    expect(await leavePendingFields("u", () => ["b"])).toBe(true);
    expect(ops()).not.toContain("delete");
    expect(pendingLeaves("u")).toEqual([]);
  });

  it("keeps what it owes when the delete fails, for the retry", async () => {
    noteListedEditions("u", ["b"], []);
    h.results.push({ error: { message: "offline" } });
    expect(await leavePendingFields("u", () => [])).toBe(false);
    expect(pendingLeaves("u")).toEqual(["b"]);
  });

  it("keeps a removal when storage writes fail but reads still work", async () => {
    localStorage.setItem("rc_field_leaves:w", "[]");
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    noteListedEditions("w", ["b"], []);
    expect(pendingLeaves("w")).toEqual(["b"]);
    expect(await leavePendingFields("w", () => [])).toBe(true);
    expect(h.calls.find(c => c[0] === "in")).toEqual(["in", "edition_id", ["b"]]);
    set.mockRestore();
  });

  it("holds a join until an owed delete in flight has landed", async () => {
    noteListedEditions("v", ["b"], []);
    const order: string[] = [];
    let land: (v: { error: null }) => void = () => {};
    h.results.push(new Promise(r => { land = r; }) as never);
    const leave = leavePendingFields("v", () => []).then(() => order.push("delete"));
    const join = setFieldChoice("v", "b", "count", null, null).then(() => order.push("insert"));
    await Promise.resolve();
    expect(order).toEqual([]);
    land({ error: null });
    await Promise.all([leave, join]);
    expect(order).toEqual(["delete", "insert"]);
  });

  it("holds a join until every overlapping delete has landed", async () => {
    noteListedEditions("x", ["b"], []);
    const order: string[] = [];
    let landOld: (v: { error: null }) => void = () => {};
    h.results.push(new Promise(r => { landOld = r; }) as never, { error: null });
    const older = leavePendingFields("x", () => []).then(() => order.push("old delete"));
    noteListedEditions("x", ["c"], []);
    await leavePendingFields("x", () => []);
    const join = setFieldChoice("x", "b", "count", null, null).then(() => order.push("insert"));
    await Promise.resolve();
    expect(order).toEqual([]);
    landOld({ error: null });
    await Promise.all([older, join]);
    expect(order).toEqual(["old delete", "insert"]);
  });

  it("turns a change into a join when its row was deleted meanwhile", async () => {
    h.results.push({ data: [], error: null }, { error: null });
    expect(await setFieldChoice("u", "b", "count", null, { visibility: "named", goalSec: null })).toBe("ok");
    expect(ops()).toContain("insert");
  });

  it("is per user", () => {
    noteListedEditions("u", ["b"], []);
    expect(pendingLeaves("other")).toEqual([]);
  });
});

describe("createFieldReconciler", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("retries a failing run on a backoff, and stops once it succeeds", async () => {
    const results = [false, false, true];
    const run = vi.fn(async () => results.shift() ?? true);
    const rec = createFieldReconciler(run);
    rec.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(run).toHaveBeenCalledTimes(3);
    rec.stop();
  });

  it("runs again after an in-flight run when asked meanwhile", async () => {
    let release: (v: boolean) => void = () => {};
    const run = vi.fn(() => new Promise<boolean>(r => { release = r; }));
    const rec = createFieldReconciler(run);
    rec.run(); rec.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    release(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    release(true);
    rec.stop();
  });

  it("schedules nothing once stopped, even when a run in flight fails", async () => {
    let release: (v: boolean) => void = () => {};
    const run = vi.fn(() => new Promise<boolean>(r => { release = r; }));
    const rec = createFieldReconciler(run);
    rec.run();
    await vi.advanceTimersByTimeAsync(0);
    rec.stop();
    release(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
