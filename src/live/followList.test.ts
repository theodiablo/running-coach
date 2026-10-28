// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  FOLLOW_COLORS, FOLLOW_KEY, FOLLOW_MAX, FOLLOW_TTL_MS, followRunner, forgetAllRunners, readFollows,
  sameNameAs, unfollowRunner,
} from "./followList";

// The follow list is a set of standing links to people's live location, kept on
// a possibly shared device. It must be written only when asked, keep the
// minimum, and survive a second tab writing at the same time.

const tok = (c: string) => c.repeat(22);
const stored = () => JSON.parse(localStorage.getItem(FOLLOW_KEY) ?? "null");

beforeEach(() => localStorage.clear());

describe("followList", () => {
  it("never writes on a read", () => {
    expect(readFollows()).toEqual([]);
    expect(localStorage.getItem(FOLLOW_KEY)).toBeNull();
  });

  it("stores the token, the viewer's label, a colour and when it was added, nothing else", () => {
    const out = followRunner(tok("a"), "  Marie  ", null, 1000);
    expect(out.ok).toBe(true);
    expect(stored()).toEqual({ v: 1, runners: [{ token: tok("a"), name: "Marie", color: FOLLOW_COLORS[0], addedAt: 1000 }] });
  });

  it("refuses a malformed token and a full list", () => {
    expect(followRunner("nope", "x")).toEqual({ ok: false, reason: "invalid" });
    const letters = "abcdefghijk".split("");
    letters.slice(0, FOLLOW_MAX).forEach(c => followRunner(tok(c), c));
    expect(followRunner(tok("k"), "k")).toEqual({ ok: false, reason: "full" });
    expect(readFollows()).toHaveLength(FOLLOW_MAX);
  });

  it("gives each runner its own colour, kept when someone else is removed", () => {
    followRunner(tok("a"), "A");
    followRunner(tok("b"), "B");
    unfollowRunner(tok("a"));
    followRunner(tok("c"), "C");
    const colors = Object.fromEntries(readFollows().map(r => [r.name, r.color]));
    expect(colors).toEqual({ B: FOLLOW_COLORS[1], C: FOLLOW_COLORS[0] });
  });

  it("replaces a runner's old link in place, keeping their colour", () => {
    followRunner(tok("a"), "Marie");
    followRunner(tok("b"), "Léa");
    expect(sameNameAs(readFollows(), tok("c"), "marie")?.token).toBe(tok("a"));
    followRunner(tok("c"), "Marie", tok("a"));
    expect(readFollows().map(r => [r.token, r.color])).toEqual([[tok("c"), FOLLOW_COLORS[0]], [tok("b"), FOLLOW_COLORS[1]]]);
  });

  it("drops entries older than the window and anything that isn't a token", () => {
    const now = Date.now();
    localStorage.setItem(FOLLOW_KEY, JSON.stringify({ v: 1, runners: [
      { token: tok("a"), name: "old", color: FOLLOW_COLORS[0], addedAt: now - FOLLOW_TTL_MS - 1 },
      { token: "<img onerror=x>", name: "bad", color: FOLLOW_COLORS[1], addedAt: now },
      { token: tok("b"), name: "ok", color: "javascript:alert(1)", addedAt: now },
    ] }));
    expect(readFollows(now)).toEqual([{ token: tok("b"), name: "ok", color: FOLLOW_COLORS[0], addedAt: now }]);
  });

  it("ignores another version's shape rather than misreading or deleting it", () => {
    localStorage.setItem(FOLLOW_KEY, JSON.stringify([{ token: tok("a") }]));
    expect(readFollows()).toEqual([]);
    const v2 = JSON.stringify({ v: 2, runners: [{ token: tok("a") }] });
    localStorage.setItem(FOLLOW_KEY, v2);
    expect(readFollows()).toEqual([]);
    expect(localStorage.getItem(FOLLOW_KEY)).toBe(v2);
  });

  it("merges with what another tab wrote since this one read", () => {
    followRunner(tok("a"), "A");
    // Another tab adds B straight to storage.
    const other = stored();
    other.runners.push({ token: tok("b"), name: "B", color: FOLLOW_COLORS[1], addedAt: Date.now() });
    localStorage.setItem(FOLLOW_KEY, JSON.stringify(other));
    followRunner(tok("c"), "C");
    expect(readFollows().map(r => r.name)).toEqual(["A", "B", "C"]);
  });

  it("removes the key entirely when the list is emptied", () => {
    followRunner(tok("a"), "A");
    expect(forgetAllRunners()).toEqual([]);
    expect(localStorage.getItem(FOLLOW_KEY)).toBeNull();
  });

  it("deletes expired links from storage, not just from the list it returns", () => {
    const now = Date.now();
    localStorage.setItem(FOLLOW_KEY, JSON.stringify({ v: 1, runners: [
      { token: tok("a"), name: "old", color: FOLLOW_COLORS[0], addedAt: now - FOLLOW_TTL_MS - 1 },
    ] }));
    expect(readFollows(now)).toEqual([]);
    expect(localStorage.getItem(FOLLOW_KEY)).toBeNull();
  });

  it("keeps every runner for the visit when storage is blocked", async () => {
    // A fresh module: once storage fails, the list stays in memory for the visit.
    vi.resetModules();
    const m = await import("./followList");
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    try {
      m.followRunner(tok("a"), "A");
      m.followRunner(tok("b"), "B");
      expect(m.readFollows().map(r => r.name)).toEqual(["A", "B"]);
    } finally {
      set.mockRestore();
    }
  });
});

