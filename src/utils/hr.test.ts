import { describe, it, expect } from "vitest";
import {
  hrZoneBpm, sessionHR, runZoneIndex, parseHrMeasurement, hrSummary, SESSION_ZONES,
  tanakaMaxHR, deriveAge, runnerAge, effectiveMaxHR, timeInZones,
  hrMeasuredSec, hrCoverage, mergeHrSamples,
} from "./hr";

type HrSample = { bpm: number; t: number };

const summarize = hrSummary as (samples?: HrSample[]) => { hr: number | null; hrAvg: number | null; hrMax: number | null };

// Build a DataView the way Web Bluetooth / the BLE plugin deliver a characteristic.
const dv = (bytes: number[]) => new DataView(Uint8Array.from(bytes).buffer);

// Fixed clock so birth-year derivations don't drift as real years pass.
const TODAY = new Date("2026-07-18T00:00:00");

describe("deriveAge", () => {
  it("derives age from a birth year", () => {
    expect(deriveAge(1985, TODAY)).toBe(41);
  });
  it("accepts the 10..90 boundary ages", () => {
    expect(deriveAge(2016, TODAY)).toBe(10);
    expect(deriveAge(1936, TODAY)).toBe(90);
  });
  it("returns null for absent or implausible years", () => {
    expect(deriveAge(undefined, TODAY)).toBeNull();
    expect(deriveAge(0, TODAY)).toBeNull();
    expect(deriveAge(1900, TODAY)).toBeNull(); // age 126
    expect(deriveAge(2025, TODAY)).toBeNull(); // age 1
  });
});

describe("runnerAge", () => {
  it("prefers birthYear over the legacy static age", () => {
    expect(runnerAge({birthYear: 1985, age: 30}, TODAY)).toBe(41);
  });
  it("falls back to a plausible legacy age (pre-birthYear blobs)", () => {
    expect(runnerAge({age: 41}, TODAY)).toBe(41);
  });
  it("returns null when both are unset or implausible", () => {
    expect(runnerAge({}, TODAY)).toBeNull();
    expect(runnerAge({age: 0}, TODAY)).toBeNull();
    expect(runnerAge({age: 200}, TODAY)).toBeNull();
  });
});

describe("effectiveMaxHR", () => {
  it("prefers an explicit max HR over any estimate", () => {
    expect(effectiveMaxHR({maxHR: 192, birthYear: 1985}, TODAY)).toBe(192);
  });
  it("estimates via Tanaka from birthYear", () => {
    // age 41 → 208 − 0.7×41 = 179.3 → 179
    expect(effectiveMaxHR({maxHR: 0, birthYear: 1985}, TODAY)).toBe(179);
  });
  it("estimates via Tanaka from the legacy age", () => {
    expect(effectiveMaxHR({maxHR: 0, age: 41}, TODAY)).toBe(179);
  });
  it("returns 0 with no usable profile", () => {
    expect(effectiveMaxHR({}, TODAY)).toBe(0);
  });
});

describe("tanakaMaxHR", () => {
  it("rounds 208 − 0.7 × age", () => {
    expect(tanakaMaxHR(20)).toBe(194);
    expect(tanakaMaxHR(60)).toBe(166);
  });
});

describe("hrZoneBpm", () => {
  it("computes Karvonen (heart-rate reserve) ranges", () => {
    // HRR = 200 - 60 = 140; lo = 140*0.5 + 60, hi = 140*0.6 + 60
    expect(hrZoneBpm(0.5, 0.6, 200, 60)).toEqual({lo: 130, hi: 144});
  });
  it("returns null without a max HR", () => {
    expect(hrZoneBpm(0.5, 0.6, 0, 60)).toBeNull();
  });
  it("returns null when heart-rate reserve is non-positive", () => {
    expect(hrZoneBpm(0.5, 0.6, 60, 60)).toBeNull();
  });
});

describe("sessionHR", () => {
  const settings = {maxHR: 200, restHR: 60};

  it("maps EASY to its Z2 range", () => {
    const r = sessionHR("EASY", settings);
    expect(r).toMatchObject({lo: 144, hi: 158, label: SESSION_ZONES.EASY.label});
  });
  it("spans multiple zones for TEMPO (Z3-4)", () => {
    const r = sessionHR("TEMPO", settings)!;
    // lo from zone 3 (0.70), hi from zone 4 (0.90)
    expect(r.lo).toBe(158);
    expect(r.hi).toBe(186);
  });
  it("falls back to EASY for unknown types", () => {
    expect(sessionHR("MYSTERY", settings)).toEqual(sessionHR("EASY", settings));
  });
  it("returns null without a max HR", () => {
    expect(sessionHR("EASY", {maxHR: 0, restHR: 60})).toBeNull();
  });
});

describe("runZoneIndex", () => {
  // Karvonen on maxHR 200 / restHR 60 (HRR 140): Z1 130-144, Z2 144-158,
  // Z3 158-172, Z4 172-186, Z5 186+.
  it("classifies an HR into its Karvonen zone", () => {
    expect(runZoneIndex(150, 200, 60)).toBe(2);
    expect(runZoneIndex(180, 200, 60)).toBe(4);
  });
  it("treats the top zone as open-ended", () => {
    expect(runZoneIndex(210, 200, 60)).toBe(5);
  });
  it("returns null without an HR or max HR", () => {
    expect(runZoneIndex(0, 200, 60)).toBeNull();
    expect(runZoneIndex(150, 0, 60)).toBeNull();
  });
});

describe("parseHrMeasurement", () => {
  it("parses an 8-bit bpm (flags bit0 = 0)", () => {
    // flags 0x00, bpm 0x91 = 145
    expect(parseHrMeasurement(dv([0x00, 0x91]))).toEqual({ bpm: 145, rr: [] });
  });
  it("parses a 16-bit bpm (flags bit0 = 1, little-endian)", () => {
    // flags 0x01, bpm 0x012C = 300
    expect(parseHrMeasurement(dv([0x01, 0x2c, 0x01]))).toEqual({ bpm: 300, rr: [] });
  });
  it("skips energy-expended and reads trailing R-R intervals", () => {
    // flags 0x18 (energy bit3 + RR bit4), bpm 150, energy 0x0000, RR 0x0300 = 768/1024 s
    expect(parseHrMeasurement(dv([0x18, 0x96, 0x00, 0x00, 0x00, 0x03]))).toEqual({ bpm: 150, rr: [750] });
  });
  it("reads multiple R-R intervals", () => {
    // flags 0x10 (RR only), bpm 150, RR 0x0300 (750ms) then 0x0200 (500ms)
    expect(parseHrMeasurement(dv([0x10, 0x96, 0x00, 0x03, 0x00, 0x02]))!.rr).toEqual([750, 500]);
  });
  it("tolerates flags declaring fields that aren't present", () => {
    // flags 0x10 (RR bit set) but no trailing RR bytes → bpm parsed, rr empty
    expect(parseHrMeasurement(dv([0x10, 0x96]))).toEqual({ bpm: 150, rr: [] });
    // sensor-contact bits (0x06) set alongside an 8-bit bpm — must not shift parsing
    expect(parseHrMeasurement(dv([0x06, 0x91]))).toEqual({ bpm: 145, rr: [] });
  });
  it("returns null for missing, empty, too-short, or zero-bpm data", () => {
    expect(parseHrMeasurement(null)).toBeNull();
    expect(parseHrMeasurement(dv([]))).toBeNull();
    expect(parseHrMeasurement(dv([0x00]))).toBeNull(); // flags but no value
    expect(parseHrMeasurement(dv([0x01, 0x2c]))).toBeNull(); // 16-bit flag but truncated value
    expect(parseHrMeasurement(dv([0x00, 0x00]))).toBeNull(); // 0 bpm = no contact
  });
});

describe("hrSummary", () => {
  it("reduces samples to latest / average / max", () => {
    const samples = [{ bpm: 120, t: 1 }, { bpm: 150, t: 2 }, { bpm: 140, t: 3 }];
    expect(hrSummary(samples)).toEqual({ hr: 140, hrAvg: 137, hrMax: 150 });
  });
  it("returns nulls for an empty/absent stream", () => {
    expect(hrSummary([])).toEqual({ hr: null, hrAvg: null, hrMax: null });
    expect(summarize(undefined)).toEqual({ hr: null, hrAvg: null, hrMax: null });
  });
});

describe("timeInZones", () => {
  // maxHR 200, restHR 50 ⇒ reserve 150. Karvonen bands:
  // Z1 125-140, Z2 140-155, Z3 155-170, Z4 170-185, Z5 185-200.
  const MAX = 200, REST = 50;

  it("accumulates the gap between samples into the earlier sample's zone", () => {
    const samples = [{ bpm: 130, t: 0 }, { bpm: 150, t: 1000 }, { bpm: 160, t: 2000 }];
    const z = timeInZones(samples, MAX, REST);
    expect(z).toHaveLength(5);
    expect(z[0]).toEqual({ zone: 1, sec: 1 }); // 130 bpm held for 1 s
    expect(z[1]).toEqual({ zone: 2, sec: 1 }); // 150 bpm held for 1 s
    expect(z[2].sec).toBe(0);
  });

  it("caps a long gap so a paused stretch can't inflate a zone", () => {
    const samples = [{ bpm: 130, t: 0 }, { bpm: 130, t: 100_000 }]; // 100 s gap
    const z = timeInZones(samples, MAX, REST, { capSec: 10 });
    expect(z[0].sec).toBe(10); // capped, not 100
  });

  it("returns [] for an empty, single, or absent stream", () => {
    expect(timeInZones([], MAX, REST)).toEqual([]);
    expect(timeInZones([{ bpm: 130, t: 0 }], MAX, REST)).toEqual([]);
    expect(timeInZones(undefined, MAX, REST)).toEqual([]);
  });

  it("returns [] when the profile can't classify (no maxHR / no reserve)", () => {
    const samples = [{ bpm: 130, t: 0 }, { bpm: 150, t: 1000 }];
    expect(timeInZones(samples, 0, REST)).toEqual([]);
    expect(timeInZones(samples, 100, 100)).toEqual([]); // reserve 0
  });
});

describe("hrMeasuredSec / hrCoverage", () => {
  // A 2Hz strap, the cadence a real chest strap notifies at.
  const stream = (fromSec: number, toSec: number) => {
    const out: HrSample[] = [];
    for (let t = fromSec; t <= toSec; t += 0.5) out.push({ bpm: 150, t: t * 1000 });
    return out;
  };

  it("measures nothing from fewer than two samples", () => {
    expect(hrMeasuredSec([])).toBe(0);
    expect(hrMeasuredSec([{ bpm: 150, t: 0 }])).toBe(0);
  });

  it("counts a continuous stream as its own span", () => {
    expect(hrMeasuredSec(stream(0, 600))).toBeCloseTo(600, 1);
  });

  it("caps a dropped link rather than counting the hole as measured", () => {
    // Two 60s bursts an hour apart: the hole contributes the 10s cap, not an hour.
    const samples = [...stream(0, 60), ...stream(3600, 3660)];
    expect(hrMeasuredSec(samples)).toBeCloseTo(130, 1);
  });

  it("reports coverage as a fraction of the run, clamped to 1", () => {
    expect(hrCoverage(stream(0, 600), 600)).toBeCloseTo(1, 2);
    expect(hrCoverage(stream(0, 300), 600)).toBeCloseTo(0.5, 2);
    expect(hrCoverage(stream(0, 900), 600)).toBe(1);
    expect(hrCoverage([], 600)).toBe(0);
    expect(hrCoverage(stream(0, 600), 0)).toBe(0);
  });

  it("adapts the cap to a coarse imported series", () => {
    // A watch / Health Connect / smart-recorded GPX import can legitimately be
    // one sample a minute. A fixed 10s cap scored that continuous series at 17%
    // and the detail view called it a dropout.
    const oncePerMinute = Array.from({ length: 61 }, (_, i) => ({ bpm: 150, t: i * 60000 }));
    expect(hrCoverage(oncePerMinute, 3600)).toBeCloseTo(1, 2);
    const every11s = Array.from({ length: 100 }, (_, i) => ({ bpm: 150, t: i * 11000 }));
    expect(hrCoverage(every11s, 99 * 11)).toBeCloseTo(1, 2);
  });

  it("still catches a dropout inside a coarse series", () => {
    // Same 1/min cadence, but an hour missing in the middle: the adaptive cap is
    // 3 minutes, so the hole counts for 3 of its 60 minutes, not all of it.
    const samples = [
      ...Array.from({ length: 10 }, (_, i) => ({ bpm: 150, t: i * 60000 })),
      ...Array.from({ length: 10 }, (_, i) => ({ bpm: 150, t: 3600000 + i * 60000 })),
    ];
    expect(hrCoverage(samples, 4200)).toBeLessThan(0.35);
  });

  it("honours an explicit cap over the derived one", () => {
    const oncePerMinute = Array.from({ length: 61 }, (_, i) => ({ bpm: 150, t: i * 60000 }));
    expect(hrMeasuredSec(oncePerMinute, 10)).toBeCloseTo(600, 1);
  });

  it("scores the real-world fragment low", () => {
    // The Aug 10 shape: ~15 minutes of stream on a 72-minute run.
    expect(hrCoverage(stream(0, 900), 4313)).toBeLessThan(0.25);
  });
});

describe("mergeHrSamples", () => {
  it("returns the sorted base when there is nothing to merge", () => {
    const base = [{ bpm: 150, t: 2000 }, { bpm: 140, t: 1000 }];
    expect(mergeHrSamples(base, [])).toEqual([{ bpm: 140, t: 1000 }, { bpm: 150, t: 2000 }]);
    expect(mergeHrSamples(null, null)).toEqual([]);
  });

  it("takes the journal wholesale when JS saw nothing", () => {
    const journal = [{ bpm: 150, t: 1000 }, { bpm: 152, t: 1500 }];
    expect(mergeHrSamples([], journal)).toEqual(journal);
  });

  it("drops journal entries that duplicate a live sample within tolerance", () => {
    // The same notification, timestamped natively and again on JS delivery.
    const live = [{ bpm: 150, t: 1000 }, { bpm: 152, t: 1500 }];
    const journal = [{ bpm: 150, t: 990 }, { bpm: 152, t: 1512 }];
    expect(mergeHrSamples(live, journal)).toEqual(live);
  });

  it("keeps journal beats from the stretch JS was frozen for", () => {
    const live = [{ bpm: 150, t: 1000 }, { bpm: 158, t: 60000 }];
    const journal = Array.from({ length: 10 }, (_, i) => ({ bpm: 155, t: 5000 + i * 500 }));
    const merged = mergeHrSamples(live, journal);
    expect(merged).toHaveLength(12);
    expect(merged.map(s => s.t)).toEqual([...merged.map(s => s.t)].sort((a, b) => a - b));
  });

  it("ignores malformed journal entries", () => {
    const live = [{ bpm: 150, t: 1000 }];
    const bad = [{ bpm: 0, t: 2000 }, { bpm: 150, t: NaN }] as HrSample[];
    expect(mergeHrSamples(live, bad)).toEqual(live);
  });
});
