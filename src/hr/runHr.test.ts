import { describe, it, expect, vi, beforeEach } from "vitest";

// The one HR resolver both recorders finish a session through. What it protects:
// a live stream is completed from the native journal before anything is claimed
// off it, a fragment never becomes a run-level average, and a post-run store is
// only consulted when no live stream answered.
const j = vi.hoisted(() => ({ read: vi.fn<() => Promise<{ bpm: number; t: number }[]>>() }));
vi.mock("./hrJournal", () => ({ readHrJournal: j.read }));
vi.mock("../native", () => ({ isNative: true, isAndroid: true, isIos: false, platform: "android" }));
const dev = vi.hoisted(() => ({ paired: vi.fn(), hc: vi.fn(), hk: vi.fn() }));
vi.mock("./device", () => ({ getPairedDevice: dev.paired }));
vi.mock("./healthconnect", () => ({ hasHealthConnectAuthorization: dev.hc }));
vi.mock("../healthkit/import", () => ({ hasHealthKitAuthorization: dev.hk }));

import { recorderHrSetup, resolveRunHr, runHrFields } from "./runHr";

const stream = (from: number, sec: number, bpm = 150) =>
  Array.from({ length: sec }, (_, i) => ({ bpm, t: from + i * 1000 }));

const liveSrc = { id: "bluetooth", live: true } as never;
const postRun = (impl: () => Promise<{ hrAvg?: number; hrMax?: number }>) =>
  ({ id: "healthconnect", live: false, fetchRange: vi.fn(impl) }) as never;

beforeEach(() => { j.read.mockReset().mockResolvedValue([]); });

describe("resolveRunHr", () => {
  it("folds the native journal into what JS saw, and dedupes the overlap", async () => {
    const t0 = 1_700_000_000_000;
    j.read.mockResolvedValue(stream(t0, 600, 150)); // the whole run, natively
    const res = await resolveRunHr({
      hrSrc: liveSrc, liveSamples: stream(t0, 60, 150), durationSec: 600, startMs: t0, endMs: t0 + 600_000,
    });
    expect(res.samples).toHaveLength(600); // not 660 — the first minute is one stream
    expect(res.hr).toBe(150);
    expect(res.partialCoverage).toBeNull();
  });

  it("reports partial coverage instead of averaging a fragment", async () => {
    const t0 = 1_700_000_000_000;
    const res = await resolveRunHr({
      hrSrc: liveSrc, liveSamples: stream(t0, 60, 85), durationSec: 4200, startMs: t0, endMs: t0 + 4_200_000,
    });
    expect(res.hr).toBeNull();
    expect(res.samples).toHaveLength(60); // kept — run detail explains the gap
    expect(res.partialCoverage).toBeLessThan(0.5);
  });

  it("never reads the journal for a post-run source", async () => {
    j.read.mockResolvedValue(stream(1, 600)); // an earlier BLE run's beats
    const src = postRun(async () => ({ hrAvg: 142, hrMax: 171 }));
    const res = await resolveRunHr({ hrSrc: src, liveSamples: [], durationSec: 600, startMs: 1000, endMs: 2000 });
    expect(j.read).not.toHaveBeenCalled();
    expect(res).toMatchObject({ hr: 142, hrMax: 171, hrPending: null });
  });

  it("stamps a pending marker when the store has nothing yet", async () => {
    const src = postRun(async () => ({}));
    const res = await resolveRunHr({ hrSrc: src, liveSamples: [], durationSec: 600, startMs: 1000, endMs: 2000 });
    expect(res.hrPending).toEqual({ start: 1000, end: 2000, source: "healthconnect" });
  });

  it("survives a store that throws", async () => {
    const src = postRun(async () => { throw new Error("unsynced"); });
    const res = await resolveRunHr({ hrSrc: src, liveSamples: [], durationSec: 600, startMs: 1000, endMs: 2000 });
    expect(res.hrPending?.source).toBe("healthconnect");
  });

  it("leaves everything null with no source at all", async () => {
    const res = await resolveRunHr({ hrSrc: null, liveSamples: [], durationSec: 600, startMs: 1000, endMs: 2000 });
    expect(res).toMatchObject({ hr: null, hrMax: null, hrPending: null, partialCoverage: null });
  });
});

describe("runHrFields", () => {
  it("routes a HealthKit marker to its own field", () => {
    const base = { samples: [], hr: null, hrMax: null, partialCoverage: null };
    const hk = runHrFields({ ...base, hrPending: { start: 1, end: 2, source: "healthkit" } });
    expect(hk).toEqual({ hrPendingHk: { start: 1, end: 2, source: "healthkit" } });
    const hc = runHrFields({ ...base, hrPending: { start: 1, end: 2, source: "healthconnect" } });
    expect(hc).toEqual({ hrPending: { start: 1, end: 2, source: "healthconnect" } });
  });

  it("omits hr entirely when there is none to claim", () => {
    expect(runHrFields({ samples: [], hr: null, hrMax: null, hrPending: null, partialCoverage: 0.2 })).toEqual({});
  });
});

describe("recorderHrSetup", () => {
  // The synced method is a preference; the pairing/grant it needs is per-install.
  // This is the gate on whether a native bridge is touched at all, so each row
  // states both halves: what the recorder runs with, and what it offers instead.
  beforeEach(() => {
    dev.paired.mockReset().mockReturnValue(null);
    dev.hc.mockReset().mockReturnValue(false);
    dev.hk.mockReset().mockReturnValue(false);
  });

  it("keeps a method whose device state backs it", () => {
    dev.paired.mockReturnValue({ id: "d1", name: "Polar H10" });
    expect(recorderHrSetup("bluetooth")).toEqual({ method: "bluetooth", nudge: null });
    dev.hc.mockReturnValue(true);
    expect(recorderHrSetup("healthconnect")).toEqual({ method: "healthconnect", nudge: null });
  });

  it("falls back to off, and offers the prompt that names what is missing", () => {
    expect(recorderHrSetup("bluetooth")).toEqual({ method: "off", nudge: { id: "pair", allowOptOut: false } });
    expect(recorderHrSetup("healthconnect")).toEqual({ method: "off", nudge: { id: "auth", allowOptOut: false } });
  });

  it("offers the generic prompt when HR is simply off, and honours the opt-out", () => {
    expect(recorderHrSetup("off").nudge).toEqual({ id: "setup", allowOptOut: true });
    expect(recorderHrSetup("off", true).nudge).toBeNull();
  });

  it("never prompts about the other platform's method", () => {
    // healthkit on Android: effectively off here, but a re-authorize prompt
    // would be meaningless and the generic one would mislead.
    expect(recorderHrSetup("healthkit")).toEqual({ method: "off", nudge: null });
  });
});
