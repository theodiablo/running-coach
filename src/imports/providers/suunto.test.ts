import { beforeEach, describe, it, expect, vi } from "vitest";

// Mock the OAuth factory so suuntoEnabled is true without VITE_SUUNTO_CLIENT_ID
// and the edge-function invoke is controllable — the REAL scan loop (deferred
// ack, cursor rules, transient stops) is what's under test.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../cloudOauth", () => ({
  makeCloudOauth: (spec: { provider: string }) => ({
    enabled: true,
    connect: vi.fn(),
    completeAuth: vi.fn(),
    invoke: (body: Record<string, unknown>) => invokeMock({ fn: spec.provider, ...body }),
    expectedStates: (nonce: string) => [`${spec.provider}_import:${nonce}`, `${spec.provider}_import:native:${nonce}`],
  }),
}));

import { suuntoWorkoutToRun, suuntoProvider, commitSuuntoScan, suuntoBackfillPending } from "./suunto";
import type { Run } from "../../types";

// Minimal valid FIT byte stream (same builder as fit.test.ts): 14-byte header,
// one `record` definition, N record messages.
const SEMI = 2 ** 31 / 180;
function buildFit(points: { lat: number; lng: number; altM: number; hr: number; tFit: number; distM: number }[]) {
  const bytes: number[] = [];
  const u16 = (v: number) => { bytes.push(v & 0xff, (v >> 8) & 0xff); };
  const u32 = (v: number) => { bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); };
  const def: number[] = [0x40, 0x00, 0x00, 0x14, 0x00, 6,
    253, 4, 0x86, 0, 4, 0x85, 1, 4, 0x85, 2, 2, 0x84, 3, 1, 0x02, 5, 4, 0x86];
  const data: number[] = [...def];
  const w32 = (v: number) => data.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const w16 = (v: number) => data.push(v & 0xff, (v >> 8) & 0xff);
  for (const p of points) {
    data.push(0x00);
    w32(p.tFit);
    w32(Math.round(p.lat * SEMI) >>> 0);
    w32(Math.round(p.lng * SEMI) >>> 0);
    w16(Math.round((p.altM + 500) * 5));
    data.push(p.hr & 0xff);
    w32(Math.round(p.distM * 100));
  }
  bytes.push(14, 0x10); u16(0x0100); u32(data.length);
  bytes.push(0x2e, 0x46, 0x49, 0x54); u16(0);
  bytes.push(...data); u16(0);
  return new Uint8Array(bytes);
}
const FIT_B64 = Buffer.from(buildFit([
  { lat: 45.000, lng: 5.000, altM: 200, hr: 140, tFit: 1_000_000_000, distM: 0 },
  { lat: 45.010, lng: 5.000, altM: 210, hr: 160, tFit: 1_000_000_600, distM: 1113 },
])).toString("base64");

beforeEach(() => {
  invokeMock.mockReset();
});

describe("suuntoWorkoutToRun", () => {
  const START = Date.UTC(2026, 6, 10, 8, 0, 0); // 2026-07-10T08:00:00Z

  it("imports a summary-only workout: distance, duration, HR, extId, UTC startedAt", () => {
    const run = suuntoWorkoutToRun({
      key: "wk1", startTime: START, staged: false,
      summary: { activityId: 3, startTime: START, totalDistance: 12000, totalTime: 3723, timeOffsetInMinutes: 120, avgHeartRate: 152.4, maxHeartRate: 178 },
    }, null);
    expect(run).toMatchObject({
      date: "2026-07-10",
      type: "EASY",
      km: 12,
      durationSec: 3723,
      hr: 152,
      hrMax: 178,
      source: "watch",
      notes: "Imported from Suunto",
      extId: "suunto:wk1",
      // Epoch-ms UTC startedAt so time-overlap dedupe works without a FIT
      // (unlike Polar's timezone-naive summary timestamps).
      startedAt: "2026-07-10T08:00:00.000Z",
    });
    expect(run!.points).toBeUndefined();
  });

  it("computes the calendar date in watch-local time via timeOffsetInMinutes", () => {
    const lateEvening = Date.UTC(2026, 6, 10, 23, 30, 0);
    const run = suuntoWorkoutToRun({
      key: "wk2", startTime: lateEvening, staged: false,
      summary: { activityId: 3, startTime: lateEvening, totalDistance: 5000, totalTime: 1800, timeOffsetInMinutes: 120 },
    }, null);
    expect(run!.date).toBe("2026-07-11"); // 23:30 UTC + 2h = next local day
    expect(run!.startedAt).toBe("2026-07-10T23:30:00.000Z");
  });

  it("maps walking activity ids to WALK and unknown ids to EASY", () => {
    const base = { startTime: START, staged: false } as const;
    const walk = suuntoWorkoutToRun({ ...base, key: "w", summary: { activityId: 1, startTime: START, totalDistance: 3000, totalTime: 1800 } }, null);
    expect(walk?.type).toBe("WALK");
    const unknown = suuntoWorkoutToRun({ ...base, key: "u", summary: { activityId: 999, startTime: START, totalDistance: 3000, totalTime: 1800 } }, null);
    expect(unknown?.type).toBe("EASY"); // server already filtered; user can re-type
  });

  it("prefers the FIT (route + HR series) and keeps the parser's startedAt", () => {
    const run = suuntoWorkoutToRun({
      key: "wk3", startTime: START, staged: false,
      // A summary whose startTime disagrees with the FIT must NOT win.
      summary: { activityId: 3, startTime: START + 3_600_000, totalDistance: 999999 },
    }, FIT_B64);
    expect(run).toBeTruthy();
    expect(run!.points).toHaveLength(2);
    expect(run).toMatchObject({ type: "EASY", source: "watch", notes: "Imported from Suunto", extId: "suunto:wk3" });
    // The FIT's own timestamp (FIT epoch), not the summary's.
    expect(run!.startedAt).not.toBe(new Date(START + 3_600_000).toISOString());
    expect(run!.hrMax).toBe(160);
  });

  it("falls back to the summary when the FIT is undecodable", () => {
    const run = suuntoWorkoutToRun({
      key: "wk4", startTime: START, staged: false,
      summary: { activityId: 3, startTime: START, totalDistance: 8000, totalTime: 2400 },
    }, "not-base64!!!");
    expect(run).toMatchObject({ km: 8, durationSec: 2400 });
  });

  it("returns null without a route or a usable distance", () => {
    expect(suuntoWorkoutToRun({ key: "z", startTime: START, staged: false, summary: { activityId: 3, startTime: START, totalDistance: 0 } }, null)).toBeNull();
    expect(suuntoWorkoutToRun({ key: "z2", startTime: 0, staged: false, summary: { activityId: 3, totalDistance: 5000 } }, null)).toBeNull();
  });
});

// ── The deferred-ack scan loop ───────────────────────────────────────────────

type Invoke = { fn: string; action: string; [k: string]: unknown };
const START = Date.UTC(2026, 6, 10, 8, 0, 0);
const summaryOf = (startTime: number) =>
  ({ activityId: 3, startTime, totalDistance: 10000, totalTime: 3000, timeOffsetInMinutes: 0 });

const ackCalls = () => invokeMock.mock.calls.map(c => c[0] as Invoke).filter(c => c.action === "ack");

describe("suunto scan", () => {
  it("defers the ack until commitSuuntoScan when the page produced runs", async () => {
    invokeMock.mockImplementation(async (body: Invoke) => {
      if (body.action === "sync") return {
        connected: true, cursor: START + 5000, hasMore: false, stagedKeys: [],
        workouts: [{ key: "a", startTime: START, staged: false, summary: summaryOf(START) }],
      };
      if (body.action === "fit") return { connected: true, gone: true }; // summary fallback
      return { ok: true };
    });
    const out = await suuntoProvider.scan!([], {});
    expect(out).toHaveLength(1);
    expect(ackCalls()).toHaveLength(0); // nothing acked before the save
    await commitSuuntoScan();
    expect(ackCalls()).toEqual([expect.objectContaining({ cursor: START + 5000 })]);
    await commitSuuntoScan(); // one-shot
    expect(ackCalls()).toHaveLength(1);
  });

  it("acks a zero-candidate page immediately (cursor advances without a user)", async () => {
    invokeMock.mockImplementation(async (body: Invoke) => {
      if (body.action === "sync") return {
        connected: true, cursor: START + 9999, hasMore: false, stagedKeys: ["drainme"], workouts: [],
      };
      return { ok: true };
    });
    const out = await suuntoProvider.scan!([], {});
    expect(out).toHaveLength(0);
    expect(ackCalls()).toEqual([expect.objectContaining({ cursor: START + 9999, stagedKeys: ["drainme"] })]);
  });

  it("a transient fit stops the batch and acks nothing past it", async () => {
    invokeMock.mockImplementation(async (body: Invoke) => {
      if (body.action === "sync") return {
        connected: true, cursor: START + 9999, hasMore: true, stagedKeys: [],
        workouts: [
          { key: "a", startTime: START, staged: false, summary: summaryOf(START) },
          { key: "b", startTime: START + 1000, staged: false, summary: summaryOf(START + 1000) },
        ],
      };
      if (body.action === "fit") {
        return body.key === "a" ? { connected: true, gone: true } : { connected: true, transient: true };
      }
      return { ok: true };
    });
    const out = await suuntoProvider.scan!([], {});
    expect(out).toHaveLength(1); // "a" imported, "b" stopped the batch
    await commitSuuntoScan();
    // The ack covers "a" only — never the server cursor past unfetched "b".
    expect(ackCalls()).toEqual([expect.objectContaining({ cursor: START })]);
  });

  it("a staged workout never advances the pending cursor past the server's", async () => {
    invokeMock.mockImplementation(async (body: Invoke) => {
      if (body.action === "sync") return {
        connected: true, cursor: 500, hasMore: false, stagedKeys: ["s1"],
        // Today's run staged mid-backfill: huge startTime, must not become the cursor.
        workouts: [{ key: "s1", startTime: START + 999_999_999, staged: true, summary: summaryOf(START + 999_999_999) }],
      };
      if (body.action === "fit") return { connected: true, gone: true };
      return { ok: true };
    });
    const out = await suuntoProvider.scan!([], {});
    expect(out).toHaveLength(1);
    await commitSuuntoScan();
    expect(ackCalls()).toEqual([expect.objectContaining({ cursor: 500, stagedKeys: ["s1"] })]);
  });

  it("feeds already-imported extIds to the server as knownKeys and flags a capped backfill", async () => {
    let pages = 0;
    invokeMock.mockImplementation(async (body: Invoke) => {
      if (body.action === "sync") {
        pages++;
        return { connected: true, cursor: START + pages, hasMore: true, stagedKeys: [], workouts: [] };
      }
      return { ok: true };
    });
    const runs = [{ id: "r1", date: "2026-07-01", km: 10, extId: "suunto:old1" } as Run];
    await suuntoProvider.scan!(runs, {});
    const firstSync = invokeMock.mock.calls.map(c => c[0] as Invoke).find(c => c.action === "sync")!;
    expect(firstSync.knownKeys).toEqual(["old1"]);
    expect(pages).toBe(10); // MAX_PAGES_PER_SCAN
    expect(suuntoBackfillPending()).toBe(true); // more behind the cap → continue next scan
  });

  it("dispatches a terminal progress event on every exit path", async () => {
    const events: { fetched: number; done: boolean }[] = [];
    const onProgress = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener("rc-cloud-sync-progress", onProgress);
    try {
      invokeMock.mockImplementation(async (body: Invoke) => {
        if (body.action === "sync") return { connected: false }; // reauth / not connected
        return { ok: true };
      });
      await suuntoProvider.scan!([], {});
      expect(events.at(-1)).toMatchObject({ done: true });
    } finally {
      window.removeEventListener("rc-cloud-sync-progress", onProgress);
    }
  });
});
