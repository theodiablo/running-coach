import { beforeEach, describe, it, expect, vi } from "vitest";

// Mock the OAuth factory so the REAL scan loop (deferred ack, cursor rules,
// transient stops, the schema tripwire) is exercisable without credentials —
// same seam suunto.test.ts uses. `specs` captures what coros.ts actually asked
// for, which is how the dormancy guarantee below is asserted.
const { invokeMock, specs } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  specs: [] as { clientId?: string; authUrl?: string; scope?: string }[],
}));
vi.mock("../cloudOauth", () => ({
  makeCloudOauth: (spec: { provider: string; clientId?: string; authUrl?: string; scope?: string }) => {
    specs.push(spec);
    return {
      enabled: true,
      connect: vi.fn(),
      completeAuth: vi.fn(),
      invoke: (body: Record<string, unknown>) => invokeMock({ fn: spec.provider, ...body }),
      expectedStates: (nonce: string) => [`${spec.provider}_import:${nonce}`, `${spec.provider}_import:native:${nonce}`],
    };
  },
}));

import { corosWorkoutToRun, corosProvider, commitCorosScan, corosBackfillPending } from "./coros";
import type { CorosWorkout } from "./coros";
import type { Run } from "../../types";

// Minimal valid FIT byte stream (same builder as fit.test.ts / suunto.test.ts):
// 14-byte header, one `record` definition, N record messages. withHr=false omits
// the HR field entirely (a watch worn without a strap).
const SEMI = 2 ** 31 / 180;
const FIT_EPOCH_OFFSET = 631065600; // FIT epoch (1989-12-31T00:00:00Z), as in fit.ts
function buildFit(points: { lat: number; lng: number; altM: number; hr?: number; tFit: number; distM: number }[], withHr = true) {
  const bytes: number[] = [];
  const u16 = (v: number) => { bytes.push(v & 0xff, (v >> 8) & 0xff); };
  const u32 = (v: number) => { bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); };
  const fields = [
    [253, 4, 0x86], [0, 4, 0x85], [1, 4, 0x85], [2, 2, 0x84],
    ...(withHr ? [[3, 1, 0x02]] : []),
    [5, 4, 0x86],
  ];
  const def: number[] = [0x40, 0x00, 0x00, 0x14, 0x00, fields.length, ...fields.flat()];
  const data: number[] = [...def];
  const w32 = (v: number) => data.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const w16 = (v: number) => data.push(v & 0xff, (v >> 8) & 0xff);
  for (const p of points) {
    data.push(0x00);
    w32(p.tFit);
    w32(Math.round(p.lat * SEMI) >>> 0);
    w32(Math.round(p.lng * SEMI) >>> 0);
    w16(Math.round((p.altM + 500) * 5));
    if (withHr) data.push((p.hr || 0) & 0xff);
    w32(Math.round(p.distM * 100));
  }
  bytes.push(14, 0x10); u16(0x0100); u32(data.length);
  bytes.push(0x2e, 0x46, 0x49, 0x54); u16(0);
  bytes.push(...data); u16(0);
  return new Uint8Array(bytes);
}
const FILE_B64 = Buffer.from(buildFit([
  { lat: 45.000, lng: 5.000, altM: 200, hr: 140, tFit: 1_000_000_000, distM: 0 },
  { lat: 45.010, lng: 5.000, altM: 210, hr: 160, tFit: 1_000_000_600, distM: 1113 },
])).toString("base64");

beforeEach(() => {
  invokeMock.mockReset();
  // Reset module state (run cache, pending ack, backfill flag) between tests —
  // disconnect is the supported reset seam.
  corosProvider.disconnect!();
  invokeMock.mockReset();
});

// ── Ships dormant ────────────────────────────────────────────────────────────

describe("coros oauth spec", () => {
  // Calibrated against COROS API Reference V2.0.6. These pin the three places
  // COROS differs from the providers already on this seam, each of which would
  // fail silently rather than loudly if it regressed.
  const spec = () => specs.find(s => s.authUrl !== undefined)!;

  it("uses the documented authorization endpoint and sends no scope", () => {
    // §3.1.2. The authorization request documents only client_id, redirect_uri,
    // state and response_type — there is no scope to send, and buildAuthUrl
    // omits the parameter entirely when the scope is empty.
    expect(spec().authUrl).toBe("https://open.coros.com/oauth2/authorize");
    expect(spec().scope).toBe("");
  });

  it("registers as a cloud provider on both platforms", () => {
    expect(corosProvider).toMatchObject({ id: "coros", label: "COROS", kind: "cloud", platform: "both" });
  });
});

// ── The pure mapper ──────────────────────────────────────────────────────────

describe("corosWorkoutToRun", () => {
  const START = Date.UTC(2026, 6, 10, 8, 0, 0); // 2026-07-10T08:00:00Z
  const base = (over: Partial<CorosWorkout> = {}): CorosWorkout => ({
    key: "wk1", startTime: START, staged: false,
    summary: { sport: "run", distanceM: 12000, durationSec: 3723, utcOffsetMin: 120 },
    ...over,
  });

  it("imports a summary-only workout: distance, duration, HR, extId, UTC startedAt", () => {
    expect(corosWorkoutToRun(base(), null)).toMatchObject({
      date: "2026-07-10",
      type: "EASY",
      km: 12,
      durationSec: 3723,
      // COROS's listing carries no heart rate at all (§4.2.4) — a workout with
      // no .fit imports as distance and duration only.
      hr: null,
      hrMax: null,
      source: "watch",
      notes: "Imported from COROS",
      extId: "coros:wk1",
      startedAt: "2026-07-10T08:00:00.000Z",
    });
    expect(corosWorkoutToRun(base(), null)!.points).toBeUndefined();
  });

  it("computes the calendar date on the watch's clock, not the phone's", () => {
    const lateEvening = Date.UTC(2026, 6, 10, 23, 30, 0);
    const run = corosWorkoutToRun(base({
      key: "wk2", startTime: lateEvening,
      summary: { sport: "run", distanceM: 5000, durationSec: 1800, utcOffsetMin: 120 },
    }), null);
    expect(run!.date).toBe("2026-07-11"); // 23:30 UTC + 2h = next local day
    expect(run!.startedAt).toBe("2026-07-10T23:30:00.000Z");
  });

  it("maps sport to the run type, defaulting an unstated sport to EASY", () => {
    const walk = corosWorkoutToRun(base({ key: "w", summary: { sport: "walk", distanceM: 3000, durationSec: 1800 } }), null);
    expect(walk?.type).toBe("WALK");
    // The server already filtered non-run activities; an unstated sport is a
    // sparse payload, not a reason to drop the run — the user can re-type it.
    const unstated = corosWorkoutToRun(base({ key: "u", summary: { distanceM: 3000, durationSec: 1800 } }), null);
    expect(unstated?.type).toBe("EASY");
  });

  it("prefers the activity file (route + HR series) and keeps the parser's startedAt", () => {
    // A summary whose startTime disagrees with the file must NOT win: a shifted
    // epoch breaks time-overlap dedupe against another copy of the same run.
    const run = corosWorkoutToRun(base({
      key: "wk3",
      summary: { sport: "run", distanceM: 999999, utcOffsetMin: 0 },
    }), FILE_B64);
    expect(run!.points).toHaveLength(2);
    expect(run).toMatchObject({ type: "EASY", source: "watch", notes: "Imported from COROS", extId: "coros:wk3" });
    expect(run!.startedAt).not.toBe(new Date(START).toISOString());
    expect(run!.hrMax).toBe(160);
  });

  it("file path computes the calendar date on the watch's clock too", () => {
    // Both branches must agree near midnight or the plan auto-tick misses runs.
    const target = Date.UTC(2026, 6, 10, 23, 30, 0);
    const tFit = target / 1000 - FIT_EPOCH_OFFSET;
    const fileB64 = Buffer.from(buildFit([
      { lat: 45.0, lng: 5.0, altM: 200, hr: 140, tFit, distM: 0 },
      { lat: 45.01, lng: 5.0, altM: 210, hr: 150, tFit: tFit + 600, distM: 1113 },
    ])).toString("base64");
    const run = corosWorkoutToRun(base({ key: "mid", startTime: target, summary: { sport: "run", utcOffsetMin: 120 } }), fileB64);
    expect(run!.startedAt).toBe("2026-07-10T23:30:00.000Z"); // parser's UTC instant kept
    expect(run!.date).toBe("2026-07-11");                    // watch-local calendar day
  });

  it("takes heart rate from the file, since the listing carries none", () => {
    // The only source of HR for a COROS import. A file recorded without a strap
    // therefore yields a run with no heart rate, and that is correct.
    const noHr = Buffer.from(buildFit([
      { lat: 45.0, lng: 5.0, altM: 200, tFit: 1_000_000_000, distM: 0 },
      { lat: 45.01, lng: 5.0, altM: 210, tFit: 1_000_000_600, distM: 1113 },
    ], false)).toString("base64");
    expect(corosWorkoutToRun(base({ key: "nohr", summary: { sport: "run", utcOffsetMin: 0 } }), noHr)?.hr).toBeFalsy();
    expect(corosWorkoutToRun(base({ key: "hr", summary: { sport: "run", utcOffsetMin: 0 } }), FILE_B64)?.hrMax).toBe(160);
  });

  it("falls back to the summary when the file is undecodable", () => {
    const run = corosWorkoutToRun(base({
      key: "bad", summary: { sport: "run", distanceM: 8000, durationSec: 2400, utcOffsetMin: 0 },
    }), "not-base64!!!");
    expect(run).toMatchObject({ km: 8, durationSec: 2400 });
  });

  it("returns null without a route or a usable distance", () => {
    expect(corosWorkoutToRun(base({ key: "z", summary: { sport: "run", distanceM: 0 } }), null)).toBeNull();
    expect(corosWorkoutToRun(base({ key: "z2", startTime: 0, summary: { sport: "run", distanceM: 5000 } }), null)).toBeNull();
  });
});

// ── The deferred-ack scan loop ───────────────────────────────────────────────

type Invoke = { fn: string; action: string; [k: string]: unknown };
const START = Date.UTC(2026, 6, 10, 8, 0, 0);
const summaryOf = () => ({ sport: "run" as const, distanceM: 10000, durationSec: 3000, utcOffsetMin: 0 });
// A listed workout carries its .fit URL (§4.2.4); the client hands it back on
// the `file` call. Without one the provider skips straight to the summary.
const FIT_URL = "https://oss.coros.com/fit/1/2.fit";
const ackCalls = () => invokeMock.mock.calls.map(c => c[0] as Invoke).filter(c => c.action === "ack");

describe("coros scan", () => {
  it("defers the ack until commitCorosScan when the page produced runs", async () => {
    invokeMock.mockImplementation(async (body: Invoke) => {
      if (body.action === "sync") return {
        connected: true, cursor: START + 5000, hasMore: false, stagedKeys: [],
        workouts: [{ key: "a", startTime: START, staged: false, fitUrl: FIT_URL, summary: summaryOf() }],
      };
      if (body.action === "file") return { connected: true, gone: true }; // summary fallback
      return { ok: true };
    });
    const out = await corosProvider.scan!([], {});
    expect(out).toHaveLength(1);
    expect(ackCalls()).toHaveLength(0); // nothing acked before the save
    await commitCorosScan();
    expect(ackCalls()).toEqual([expect.objectContaining({ cursor: START + 5000 })]);
    await commitCorosScan(); // one-shot
    expect(ackCalls()).toHaveLength(1);
  });

  it("acks a zero-candidate page immediately (cursor advances without a user)", async () => {
    invokeMock.mockImplementation(async (body: Invoke) => {
      if (body.action === "sync") return {
        connected: true, cursor: START + 9999, hasMore: false, stagedKeys: ["drainme"], workouts: [],
      };
      return { ok: true };
    });
    expect(await corosProvider.scan!([], {})).toHaveLength(0);
    expect(ackCalls()).toEqual([expect.objectContaining({ cursor: START + 9999, stagedKeys: ["drainme"] })]);
  });

  it("a transient file failure stops the batch and acks nothing past it", async () => {
    invokeMock.mockImplementation(async (body: Invoke) => {
      if (body.action === "sync") return {
        connected: true, cursor: START + 9999, hasMore: true, stagedKeys: [],
        workouts: [
          { key: "a", startTime: START, staged: false, fitUrl: FIT_URL, summary: summaryOf() },
          { key: "b", startTime: START + 1000, staged: false, fitUrl: FIT_URL, summary: summaryOf() },
        ],
      };
      if (body.action === "file") return body.key === "a" ? { connected: true, gone: true } : { connected: true, transient: true };
      return { ok: true };
    });
    const out = await corosProvider.scan!([], {});
    expect(out).toHaveLength(1); // "a" imported, "b" stopped the batch
    await commitCorosScan();
    // The ack covers "a" only — never the server cursor past unfetched "b".
    expect(ackCalls()).toEqual([expect.objectContaining({ cursor: START })]);
  });

  it("a staged workout never advances the pending cursor past the server's", async () => {
    invokeMock.mockImplementation(async (body: Invoke) => {
      if (body.action === "sync") return {
        connected: true, cursor: 500, hasMore: false, stagedKeys: ["s1"],
        // Today's run arriving mid-backfill: a huge startTime that must not
        // become the watermark, or everything in between is skipped.
        workouts: [{ key: "s1", startTime: START + 999_999_999, staged: true, fitUrl: FIT_URL, summary: summaryOf() }],
      };
      if (body.action === "file") return { connected: true, gone: true };
      return { ok: true };
    });
    expect(await corosProvider.scan!([], {})).toHaveLength(1);
    await commitCorosScan();
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
    await corosProvider.scan!([{ id: "r1", date: "2026-07-01", km: 10, extId: "coros:old1" } as Run], {});
    const firstSync = invokeMock.mock.calls.map(c => c[0] as Invoke).find(c => c.action === "sync")!;
    expect(firstSync.knownKeys).toEqual(["old1"]);
    expect(pages).toBe(10); // MAX_PAGES_PER_SCAN
    expect(corosBackfillPending()).toBe(true); // more behind the cap → continue next scan
  });

  it("does not ack a page where every fetched workout maps to null", async () => {
    // The tripwire that matters most for a provider whose payload shape has
    // never been seen live: three workouts fetched fine, all mapping to null,
    // is a normalisation mismatch — acking would eat the backfill silently.
    invokeMock.mockImplementation(async (body: Invoke) => {
      if (body.action === "sync") return {
        connected: true, cursor: START + 5000, hasMore: false, stagedKeys: [],
        workouts: [0, 1, 2].map(i => ({
          key: "n" + i, startTime: START + i, staged: false, fitUrl: FIT_URL,
          summary: { sport: "run" as const, distanceM: 0 }, // maps null
        })),
      };
      if (body.action === "file") return { connected: true, gone: true };
      return { ok: true };
    });
    expect(await corosProvider.scan!([], {})).toHaveLength(0);
    expect(ackCalls()).toHaveLength(0); // no ack, the page re-serves after a fix
  });

  it("skips the file call for a workout COROS listed without a .fit", async () => {
    // An indoor or file-less workout: spending a round trip to be told there is
    // no file would burn the documented 1000-calls/minute budget for nothing.
    invokeMock.mockImplementation(async (body: Invoke) => {
      if (body.action === "sync") return {
        connected: true, cursor: START + 10, hasMore: false, stagedKeys: [],
        workouts: [{ key: "nofit", startTime: START, staged: false, fitUrl: null, summary: summaryOf() }],
      };
      return { ok: true };
    });
    const out = await corosProvider.scan!([], {});
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ km: 10, extId: "coros:nofit" });
    expect(invokeMock.mock.calls.map(c => (c[0] as Invoke).action)).not.toContain("file");
  });

  it("imports nothing and acks nothing when the edge function is unconfigured", async () => {
    // What every scan does today: coros-import has no credentials, so it
    // answers {skipped} and the provider contributes nothing to the pass.
    invokeMock.mockImplementation(async () => ({ skipped: "coros not configured", connected: false }));
    expect(await corosProvider.scan!([], {})).toHaveLength(0);
    expect(ackCalls()).toHaveLength(0);
  });
});
