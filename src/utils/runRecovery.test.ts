import { beforeEach, describe, expect, it } from "vitest";
import { INDOOR_RUN_KEY, LIVE_RUN_KEY } from "../constants";
import { normalizeRecovery, readRecoveryBuffer, type RecoveryBuffer } from "./runRecovery";
import type { StoredTrackPoint } from "./geo";

const START = 1_700_000_000_000;

const buffer = (over: Partial<RecoveryBuffer> = {}): RecoveryBuffer => ({
  points: [[48.85, 2.29, START, 30], [48.851, 2.29, START + 3000, 31]],
  hrSamples: [], accSec: 42, startAt: null, startedAt: START, stoppedAt: null,
  state: "tracking", savedAt: START + 3000,
  ...over,
});

beforeEach(() => localStorage.clear());

describe("readRecoveryBuffer", () => {
  it("returns a buffer that has points, whatever its age", () => {
    localStorage.setItem(LIVE_RUN_KEY, JSON.stringify(buffer({ savedAt: START - 30 * 86400000 })));
    expect(readRecoveryBuffer()?.points?.length).toBe(2);
    expect(localStorage.getItem(LIVE_RUN_KEY)).toBeTruthy(); // never expired away
  });

  it("returns null when nothing is stored", () => {
    expect(readRecoveryBuffer()).toBeNull();
  });

  it("removes a corrupt buffer", () => {
    localStorage.setItem(LIVE_RUN_KEY, "{not json");
    expect(readRecoveryBuffer()).toBeNull();
    expect(localStorage.getItem(LIVE_RUN_KEY)).toBeNull();
  });

  it("removes a point-less leftover (nothing worth offering)", () => {
    localStorage.setItem(LIVE_RUN_KEY, JSON.stringify(buffer({ points: [null] })));
    expect(readRecoveryBuffer()).toBeNull();
    expect(localStorage.getItem(LIVE_RUN_KEY)).toBeNull();
  });

  // An indoor session never has points, so it lives under its own key with the
  // points requirement lifted — and must stay invisible to the GPS callers.
  it("offers a point-less indoor buffer when requirePoints is off", () => {
    const indoor = buffer({ points: [], hrSamples: [{ bpm: 132, t: START }], accSec: 0, startAt: START });
    localStorage.setItem(INDOOR_RUN_KEY, JSON.stringify(indoor));
    expect(readRecoveryBuffer(INDOOR_RUN_KEY, { requirePoints: false })?.hrSamples?.length).toBe(1);
    expect(readRecoveryBuffer()).toBeNull();            // the GPS buffer is untouched
    expect(localStorage.getItem(INDOOR_RUN_KEY)).toBeTruthy();
  });

  it("still drops an indoor buffer with nothing recorded at all", () => {
    localStorage.setItem(INDOOR_RUN_KEY, JSON.stringify(
      buffer({ points: [], hrSamples: [], accSec: 0, startAt: null })));
    expect(readRecoveryBuffer(INDOOR_RUN_KEY, { requirePoints: false })).toBeNull();
    expect(localStorage.getItem(INDOOR_RUN_KEY)).toBeNull();
  });
});

describe("normalizeRecovery", () => {
  it("closes the open segment of a run that died while tracking", () => {
    // Active segment began 60s before the last persist: those 60s of moving
    // time were never folded into accSec (that only happens on pause/stop).
    const norm = normalizeRecovery(buffer({ accSec: 42, startAt: START - 57_000 }));
    expect(norm.accSec).toBe(42 + 60);
  });

  it("leaves accSec alone for a paused buffer (no open segment)", () => {
    const norm = normalizeRecovery(buffer({ state: "paused", startAt: null }));
    expect(norm.accSec).toBe(42);
  });

  // With no points there is nothing to date the end by except the last persist —
  // the whole clock of an interrupted indoor session rides on that fallback.
  it("closes a point-less indoor session's clock off savedAt", () => {
    const norm = normalizeRecovery(buffer({
      points: [], accSec: 0, startAt: START, savedAt: START + 90_000,
    }));
    expect(norm.accSec).toBe(90);
    expect(norm.points).toEqual([]);
  });

  it("merges journal points newer than the last persisted point", () => {
    const journal: StoredTrackPoint[] = [
      [48.85, 2.29, START, 30],              // duplicate of a persisted point — dropped
      [48.852, 2.29, START + 10_000, 32],    // new — merged
      [48.853, 2.29, START + 13_000, null],  // new — merged
    ];
    const norm = normalizeRecovery(buffer(), journal);
    expect(norm.points.length).toBe(4);
    expect(norm.points[3]).toEqual([48.853, 2.29, START + 13_000, null]);
  });

  it("extends the moving clock to the last journal point", () => {
    const journal: StoredTrackPoint[] = [[48.852, 2.29, START + 63_000, 32]];
    const norm = normalizeRecovery(buffer({ accSec: 0, startAt: START + 3000 }), journal);
    expect(norm.accSec).toBe(60); // (last journal t − startAt) / 1000
  });

  it("inserts a gap when the journal resumes after a long silence", () => {
    const journal: StoredTrackPoint[] = [[48.86, 2.29, START + 120_000, 40]];
    const norm = normalizeRecovery(buffer(), journal);
    expect(norm.points[2]).toBeNull();       // gap marker
    expect(norm.points[3]![2]).toBe(START + 120_000);
  });

  it("appends journal points in timestamp order", () => {
    const journal: StoredTrackPoint[] = [
      [48.853, 2.29, START + 13_000, null],
      [48.852, 2.29, START + 10_000, 32],
    ];
    const norm = normalizeRecovery(buffer(), journal);
    expect(norm.points[2]![2]).toBe(START + 10_000);
    expect(norm.points[3]![2]).toBe(START + 13_000);
  });
});
