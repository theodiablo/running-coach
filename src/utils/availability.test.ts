import { describe, it, expect } from "vitest";
import {
  sessionsFromSimple, weeklyLoad, loadBands, bandRepMinutes, clampDays, suggestSimpleAvailability,
  AVAIL_DAY_MIN, AVAIL_DAY_MAX, LOAD_GOOD_LO, LOAD_GOOD_HI,
  type DurationBand,
} from "./availability";
import { suggestPlanSessions } from "./planStyles";

describe("clampDays", () => {
  it("clamps to the 1–6 range and rounds", () => {
    expect(clampDays(0)).toBe(AVAIL_DAY_MIN);
    expect(clampDays(1)).toBe(1);
    expect(clampDays(9)).toBe(AVAIL_DAY_MAX);
    expect(clampDays(3.4)).toBe(3);
  });
});

describe("sessionsFromSimple", () => {
  const bands: DurationBand[] = ["short", "med", "long"];

  it("returns the requested number of days for every count", () => {
    for (let d = AVAIL_DAY_MIN; d <= AVAIL_DAY_MAX; d++) {
      expect(sessionsFromSimple(d, "med")).toHaveLength(d);
    }
  });

  it("always includes Sunday (dayOffset 6) as strictly the longest session", () => {
    for (let d = AVAIL_DAY_MIN; d <= AVAIL_DAY_MAX; d++) {
      for (const band of bands) {
        const sessions = sessionsFromSimple(d, band);
        const sunday = sessions.find(s => s.dayOffset === 6);
        expect(sunday).toBeDefined();
        const longest = Math.max(...sessions.map(s => s.minutes));
        expect(sunday!.minutes).toBe(longest);
        // strictly longest: no weekday ties the long run
        expect(sessions.filter(s => s.minutes === longest)).toHaveLength(1);
      }
    }
  });

  it("uses only option-set minute values", () => {
    const allowed = new Set([20, 30, 45, 60, 75, 90, 120, 150, 180]);
    for (let d = AVAIL_DAY_MIN; d <= AVAIL_DAY_MAX; d++) {
      for (const band of bands) {
        for (const s of sessionsFromSimple(d, band)) expect(allowed.has(s.minutes)).toBe(true);
      }
    }
  });

  it("keeps distinct, sorted-in-week day offsets", () => {
    const sessions = sessionsFromSimple(4, "med");
    const offsets = sessions.map(s => s.dayOffset);
    expect(new Set(offsets).size).toBe(offsets.length);
    expect(offsets.every(o => o >= 0 && o <= 6)).toBe(true);
  });

  it("clamps out-of-range day counts", () => {
    expect(sessionsFromSimple(0, "med")).toHaveLength(AVAIL_DAY_MIN);
    expect(sessionsFromSimple(99, "med")).toHaveLength(AVAIL_DAY_MAX);
  });
});

describe("suggestSimpleAvailability", () => {
  it("returns a clamped day count and a valid band", () => {
    const r = suggestSimpleAvailability(10, "occasional");
    expect(r.days).toBeGreaterThanOrEqual(AVAIL_DAY_MIN);
    expect(r.days).toBeLessThanOrEqual(AVAIL_DAY_MAX);
    expect(["short", "med", "long"]).toContain(r.band);
  });

  it("scales days up for frequent runners on longer races", () => {
    expect(suggestSimpleAvailability(21, "frequent").days).toBe(5);
    expect(suggestSimpleAvailability(5, "none").days).toBe(3);
  });

  it("picks a shorter band for short-race beginners, longer for experienced long races", () => {
    expect(suggestSimpleAvailability(5, "none").band).toBe("short");
    expect(suggestSimpleAvailability(21, "frequent").band).toBe("long");
  });

  it("resolves to option-set sessions", () => {
    const { days, band } = suggestSimpleAvailability(10, "regular");
    expect(sessionsFromSimple(days, band)).toHaveLength(days);
  });

  it("agrees with suggestPlanSessions on the day count (single heuristic)", () => {
    for (const d of [5, 10, 21.1, 42.2]) {
      for (const lvl of ["none", "occasional", "regular", "frequent"]) {
        expect(suggestSimpleAvailability(d, lvl).days).toBe(suggestPlanSessions(d, lvl).length);
      }
    }
  });
});

describe("weeklyLoad", () => {
  it("sums exact durations in custom mode", () => {
    const r = weeklyLoad({ mode: "custom", sessions: [{ dayOffset: 2, minutes: 45 }, { dayOffset: 6, minutes: 90 }] });
    expect(r.totalMin).toBe(135);
    expect(r.zone).toBe("good");
  });

  it("estimates days × representative minutes in simple mode", () => {
    const r = weeklyLoad({ mode: "simple", days: 3, band: "med" });
    expect(r.totalMin).toBe(3 * bandRepMinutes("med"));
  });

  it("classifies zones at the band boundaries", () => {
    expect(weeklyLoad({ mode: "custom", sessions: [{ dayOffset: 0, minutes: LOAD_GOOD_LO - 1 }] }).zone).toBe("low");
    expect(weeklyLoad({ mode: "custom", sessions: [{ dayOffset: 0, minutes: LOAD_GOOD_LO }] }).zone).toBe("good");
    expect(weeklyLoad({ mode: "custom", sessions: [{ dayOffset: 0, minutes: LOAD_GOOD_HI }] }).zone).toBe("good");
    expect(weeklyLoad({ mode: "custom", sessions: [{ dayOffset: 0, minutes: LOAD_GOOD_HI + 1 }] }).zone).toBe("high");
  });

  it("clamps pct into 0–100", () => {
    expect(weeklyLoad({ mode: "custom", sessions: [{ dayOffset: 0, minutes: 999 }] }).pct).toBe(100);
    expect(weeklyLoad({ mode: "custom", sessions: [] }).pct).toBe(0);
  });

  it("scales the good zone with race distance", () => {
    const sessions = [{ dayOffset: 2, minutes: 45 }, { dayOffset: 6, minutes: 90 }]; // 135 min
    expect(weeklyLoad({ mode: "custom", sessions, distanceKm: 10 }).zone).toBe("good");
    expect(weeklyLoad({ mode: "custom", sessions, distanceKm: 42.2 }).zone).toBe("low");
    const big = [{ dayOffset: 0, minutes: 60 }, { dayOffset: 2, minutes: 60 }, { dayOffset: 4, minutes: 60 }, { dayOffset: 6, minutes: 120 }]; // 300 min
    expect(weeklyLoad({ mode: "custom", sessions: big, distanceKm: 5 }).zone).toBe("high");
    expect(weeklyLoad({ mode: "custom", sessions: big, distanceKm: 42.2 }).zone).toBe("good");
  });
});

describe("loadBands", () => {
  it("keeps the short-race band as the default and widens with distance", () => {
    expect(loadBands()).toEqual({ goodLo: LOAD_GOOD_LO, goodHi: LOAD_GOOD_HI, maxMin: 360 });
    expect(loadBands(5)).toEqual(loadBands());
    expect(loadBands(21.1).goodLo).toBeGreaterThan(LOAD_GOOD_LO);
    expect(loadBands(42.2).goodLo).toBeGreaterThan(loadBands(21.1).goodLo);
    for (const d of [5, 21.1, 42.2]) {
      const b = loadBands(d);
      expect(b.goodLo).toBeLessThan(b.goodHi);
      expect(b.goodHi).toBeLessThan(b.maxMin);
    }
  });
});
