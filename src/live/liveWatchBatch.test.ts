import { describe, it, expect } from "vitest";
// @ts-expect-error Shared Deno/Vitest ESM has no TypeScript declaration file.
import * as batch from "../../supabase/functions/_shared/liveWatchBatch.mjs";

// The pure half of live-watch's batch read. Each entry must keep the single
// read's anti-probing property: anything that isn't a visible run answers the
// same `{ live: false }`, whatever else the request asked for.

type Entry = { t: string; full: boolean; since: string | null };
const b = batch as {
  BATCH_MAX: number;
  BATCH_MAX_BODY: number;
  parseBatchBody: (text: unknown) => Entry[] | null;
  validTokens: (entries: Entry[]) => string[];
  pickHead: (row: unknown) => unknown;
  answerEntry: (entry: Entry, row: unknown, fullRow: unknown, gate: unknown) => unknown;
};

const T = "a".repeat(22);
const NOW = Date.parse("2026-10-28T10:00:00Z");
const UPDATED = "2026-10-28T09:59:30.123456+00:00";
const gate = { now: NOW, maxAgeMs: 6 * 3600 * 1000, requireShare: true };
const row = (over: Record<string, unknown> = {}) => ({
  user_id: "u1", share_public: true, status: "live", started_at: "2026-10-28T09:00:00Z",
  updated_at: UPDATED, stats: { km: 5 }, h1: null, h2: [43.3, -1.9, 1, 10], h3: [43.2, -1.9, 0, 10], ...over,
});
const fullRow = (over: Record<string, unknown> = {}) => ({ ...row(over), points: [[43.2, -1.9, 0, 10], [43.3, -1.9, 1, 10], null] });
const entry = (over: Partial<Entry> = {}): Entry => ({ t: T, full: false, since: null, ...over });

describe("parseBatchBody", () => {
  it("reads entries and keeps a bad token as an entry, not an error", () => {
    expect(b.parseBatchBody(JSON.stringify({ tokens: [{ t: T, full: true, since: UPDATED }, { t: 5 }] }))).toEqual([
      { t: T, full: true, since: UPDATED },
      { t: "", full: false, since: null },
    ]);
  });

  it("refuses an oversized or malformed request as a whole", () => {
    expect(b.parseBatchBody("not json")).toBeNull();
    expect(b.parseBatchBody(JSON.stringify({ tokens: [] }))).toBeNull();
    expect(b.parseBatchBody(JSON.stringify({ token: T }))).toBeNull();
    const many = Array.from({ length: b.BATCH_MAX + 1 }, () => ({ t: T }));
    expect(b.parseBatchBody(JSON.stringify({ tokens: many }))).toBeNull();
    expect(b.parseBatchBody(" ".repeat(b.BATCH_MAX_BODY + 1))).toBeNull();
  });

  it("looks each distinct valid token up once", () => {
    expect(b.validTokens([entry(), entry(), entry({ t: "short" })])).toEqual([T]);
  });
});

describe("pickHead", () => {
  it("skips a trailing gap marker", () => {
    expect(b.pickHead(row())).toEqual([43.3, -1.9, 1, 10]);
    expect(b.pickHead(row({ h1: null, h2: null, h3: null }))).toBeNull();
  });
});

describe("answerEntry", () => {
  it("summarises an unfocused runner with a head and never a trace", () => {
    const out = b.answerEntry(entry(), row(), undefined, gate) as { run: Record<string, unknown> };
    expect(out).toEqual({
      live: true,
      run: { status: "live", started_at: "2026-10-28T09:00:00Z", updated_at: UPDATED, stats: { km: 5 }, head: [43.3, -1.9, 1, 10] },
    });
    // Nothing that names the account, and no opt-in flag, crosses the boundary.
    expect(JSON.stringify(out)).not.toMatch(/user_id|share_public|h1|points/);
  });

  it("answers every hidden case byte for byte like a missing row", () => {
    const miss = JSON.stringify(b.answerEntry(entry(), undefined, undefined, gate));
    expect(miss).toBe('{"live":false}');
    const stale = row({ updated_at: "2026-10-28T03:00:00Z" });
    for (const r of [row({ share_public: false }), stale, row({ updated_at: "garbage" })]) {
      expect(JSON.stringify(b.answerEntry(entry(), r, undefined, gate))).toBe(miss);
      // Asking for the trace, or claiming to hold it, changes nothing.
      expect(JSON.stringify(b.answerEntry(entry({ full: true, since: r.updated_at as string }), r, fullRow(), gate))).toBe(miss);
    }
  });

  it("sends the focused runner's trace, and only 'unchanged' when the caller holds the same one", () => {
    const full = b.answerEntry(entry({ full: true }), row(), fullRow(), gate) as { run: { points: unknown[] } };
    expect(full.run.points).toHaveLength(3);
    expect(JSON.stringify(full)).not.toMatch(/user_id|share_public/);
    expect(b.answerEntry(entry({ full: true, since: UPDATED }), row(), undefined, gate)).toEqual({ live: true, unchanged: true });
    // The timestamp is compared as the exact string: microseconds included.
    const close = b.answerEntry(entry({ full: true, since: "2026-10-28T09:59:30.123+00:00" }), row(), fullRow(), gate);
    expect(close).toMatchObject({ live: true, run: { points: expect.any(Array) } });
  });

  it("sends an ended run's trace unasked, since the row is about to be deleted", () => {
    const out = b.answerEntry(entry(), row({ status: "ended" }), fullRow({ status: "ended" }), gate);
    expect(out).toMatchObject({ live: true, run: { status: "ended", points: expect.any(Array) } });
  });

  it("re-gates the trace read, which can land after the run was hidden", () => {
    expect(b.answerEntry(entry({ full: true }), row(), fullRow({ share_public: false }), gate)).toEqual({ live: false });
    expect(b.answerEntry(entry({ full: true }), row(), undefined, gate)).toEqual({ live: false });
  });

  it("lets a legacy row through without the per-run flag it never had", () => {
    const legacy = { ...row(), share_public: undefined };
    expect(b.answerEntry(entry(), legacy, undefined, { ...gate, requireShare: false })).toMatchObject({ live: true });
  });
});
