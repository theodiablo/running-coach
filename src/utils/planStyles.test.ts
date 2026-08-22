import { describe, it, expect } from "vitest";
import { buildPlan } from "./plan";
import {
  pickHardDays, recommendStyle, suggestPlanSessions, levelStartLongKm,
  STYLE_PACING, STYLE_IDS, stylePacing,
} from "./planStyles";
import { ymd } from "./format";

const raceDateInDays = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return ymd(d);
};

const DAYS3 = [{ dayOffset: 1, minutes: 40 }, { dayOffset: 3, minutes: 45 }, { dayOffset: 6, minutes: 90 }];
const DAYS5 = [
  { dayOffset: 0, minutes: 40 }, { dayOffset: 1, minutes: 45 }, { dayOffset: 2, minutes: 60 },
  { dayOffset: 4, minutes: 45 }, { dayOffset: 6, minutes: 110 },
];

type S = { type: string; km: number; pace: number; desc: string; date: string };
const trainingWeeks = (plan: { weeks: { phase: string; sessions: S[] }[] }) =>
  plan.weeks.slice(0, -1);
const allSessions = (plan: { weeks: { phase: string; sessions: S[] }[] }) =>
  trainingWeeks(plan).flatMap(w => w.sessions);

describe("pickHardDays", () => {
  it("picks the day farthest (circularly) from the long day first", () => {
    // Long Sun(6): Wed(2) is 3 away both directions — farther than Fri(4).
    expect(pickHardDays([2, 4], 6, 1)).toEqual([2]);
  });

  it("keeps ≥2-day circular gaps, including the Sun→Mon wrap", () => {
    // Mon(0) is only 1 from Sun(6) around the wrap — never picked.
    expect(pickHardDays([0, 2], 6, 2)).toEqual([2]);
  });

  it("returns fewer days than asked when the layout is too dense", () => {
    // Fri(4) sits a legal 2 days from Sun(6); Sat(5) is adjacent to both.
    expect(pickHardDays([4, 5], 6, 2)).toEqual([4]);
    expect(pickHardDays([3, 4], 6, 2)).toEqual([3]);
    // Nothing clears the long day: Sat is adjacent, Mon is adjacent via wrap.
    expect(pickHardDays([0, 5], 6, 2)).toHaveLength(0);
  });
});

describe("recommendStyle", () => {
  const lotsOfRuns = (perWeekKm: number, count = 12) =>
    Array.from({ length: count }, (_, i) => ({
      date: raceDateInDays(-(i * 2 + 1)),
      km: (perWeekKm * 5) / count,
    }));

  it("recommends runwalk for a true beginner with a fitness intent", () => {
    expect(recommendStyle({ intent: "fitness", planSessions: DAYS3, distanceKm: 5, recentRuns: [] }))
      .toBe("runwalk");
  });

  it("recommends runwalk for an unfit runner targeting a short race", () => {
    expect(recommendStyle({ intent: "race", planSessions: DAYS3, distanceKm: 10, recentRuns: [] }))
      .toBe("runwalk");
  });

  it("never auto-recommends runwalk for an unfit marathoner", () => {
    expect(recommendStyle({ intent: "race", planSessions: [DAYS3[0]], distanceKm: 42.2, recentRuns: [] }))
      .toBe("balanced");
  });

  it("recommends lowfreq for a trained 3-day runner (beats hansons/polarized)", () => {
    expect(recommendStyle({ intent: "race", planSessions: DAYS3, distanceKm: 42.2, recentRuns: lotsOfRuns(40) }))
      .toBe("lowfreq");
  });

  it("recommends hansons for a high-frequency, high-volume marathoner", () => {
    expect(recommendStyle({ intent: "race", planSessions: DAYS5, distanceKm: 42.2, recentRuns: lotsOfRuns(40) }))
      .toBe("hansons");
  });

  it("recommends polarized for frequent runners below hansons volume or distance", () => {
    expect(recommendStyle({ intent: "race", planSessions: DAYS5, distanceKm: 10, recentRuns: lotsOfRuns(40) }))
      .toBe("polarized");
  });

  it("falls back to balanced on empty inputs (new user)", () => {
    expect(recommendStyle({})).toBe("balanced");
  });

  it("ignores runs older than the 35-day window", () => {
    const stale = Array.from({ length: 12 }, (_, i) => ({ date: raceDateInDays(-(50 + i)), km: 20 }));
    expect(recommendStyle({ intent: "race", planSessions: DAYS3, distanceKm: 42.2, recentRuns: stale }))
      .toBe("balanced");
  });

  it("divides volume by weeks with data, not a fixed 5", () => {
    // 2 weeks of 30 km/week: a /5 divisor would read this as 12 km/week and
    // fall back to balanced; the real load qualifies for polarized.
    const today = new Date("2026-07-08T00:00:00");
    const runs = [
      { date: "2026-06-25", km: 15 }, { date: "2026-06-27", km: 15 },
      { date: "2026-07-01", km: 15 }, { date: "2026-07-04", km: 15 },
    ];
    expect(recommendStyle({ intent: "race", planSessions: DAYS5, distanceKm: 10, recentRuns: runs, today }))
      .toBe("polarized");
  });

  it("is deterministic via an injectable today", () => {
    const today = new Date("2026-07-08T00:00:00");
    const runs = [{ date: "2026-06-20", km: 30 }, { date: "2026-06-25", km: 30 },
      { date: "2026-06-28", km: 30 }, { date: "2026-07-01", km: 35 }];
    expect(recommendStyle({ intent: "race", planSessions: DAYS3, distanceKm: 21.1, recentRuns: runs, today }))
      .toBe("lowfreq");
  });
});

describe("recommendStyle with a self-reported level (no run history)", () => {
  it("unlocks hansons for a frequent marathoner at onboarding", () => {
    expect(recommendStyle({ intent: "race", planSessions: DAYS5, distanceKm: 42.2, level: "frequent" }))
      .toBe("hansons");
  });

  it("unlocks lowfreq for a regular 3-day runner at onboarding", () => {
    expect(recommendStyle({ intent: "race", planSessions: DAYS3, distanceKm: 21.1, level: "regular" }))
      .toBe("lowfreq");
  });

  it("keeps runwalk for beginners regardless of stated level 'none'", () => {
    expect(recommendStyle({ intent: "fitness", planSessions: DAYS3, distanceKm: 5, level: "none" }))
      .toBe("runwalk");
  });

  it("real logged runs override the stated level", () => {
    // Claims frequent, but the logged history says ~6 km/week: volume gates fail.
    const runs = [{ date: raceDateInDays(-3), km: 3 }, { date: raceDateInDays(-10), km: 3 },
      { date: raceDateInDays(-17), km: 3 }, { date: raceDateInDays(-24), km: 3 }];
    expect(recommendStyle({ intent: "race", planSessions: DAYS5, distanceKm: 42.2, level: "frequent", recentRuns: runs }))
      .toBe("balanced");
  });
});

describe("recommendStyle for masters runners (age ≥ MASTERS_AGE)", () => {
  const lotsOfRuns = (perWeekKm: number, count = 12) =>
    Array.from({ length: count }, (_, i) => ({
      date: raceDateInDays(-(i * 2 + 1)),
      km: (perWeekKm * 5) / count,
    }));

  it("steers an unfit masters half-marathoner to lowfreq (was balanced)", () => {
    expect(recommendStyle({ intent: "race", planSessions: DAYS3, distanceKm: 21.1, age: 60 }))
      .toBe("lowfreq");
  });

  it("keeps runwalk for a masters beginner with a short goal", () => {
    expect(recommendStyle({ intent: "fitness", planSessions: DAYS3, distanceKm: 5, age: 60 }))
      .toBe("runwalk");
  });

  it("steers an unfit masters marathoner to lowfreq, never runwalk", () => {
    expect(recommendStyle({ intent: "race", planSessions: DAYS3, distanceKm: 42.2, age: 60 }))
      .toBe("lowfreq");
  });

  it("relaxes the 3-day lowfreq volume gate for a trained-but-light masters runner", () => {
    // 10 km/week fails the ≥20 gate for younger runners (balanced), passes for masters.
    expect(recommendStyle({ intent: "race", planSessions: DAYS3, distanceKm: 21.1, recentRuns: lotsOfRuns(10), age: 60 }))
      .toBe("lowfreq");
    expect(recommendStyle({ intent: "race", planSessions: DAYS3, distanceKm: 21.1, recentRuns: lotsOfRuns(10), age: 40 }))
      .toBe("balanced");
  });

  it("never auto-recommends hansons' cumulative-fatigue shape for masters", () => {
    const input = { intent: "race", planSessions: DAYS5, distanceKm: 42.2, recentRuns: lotsOfRuns(40) };
    expect(recommendStyle({ ...input, age: 60 })).toBe("polarized");
    expect(recommendStyle({ ...input, age: 40 })).toBe("hansons"); // unchanged below the threshold
  });

  it("changes nothing when age is unknown", () => {
    expect(recommendStyle({ intent: "race", planSessions: DAYS5, distanceKm: 42.2, recentRuns: lotsOfRuns(40), age: null }))
      .toBe("hansons");
    expect(recommendStyle({ intent: "race", planSessions: DAYS3, distanceKm: 21.1, age: undefined }))
      .toBe("balanced");
  });
});

describe("suggestPlanSessions", () => {
  const ALLOWED = [20, 30, 45, 60, 75, 90, 120, 150, 180];
  const cases: [number, string | undefined][] = [
    [5, "none"], [5, "frequent"], [10, "occasional"], [21.1, "regular"],
    [42.2, "regular"], [42.2, "frequent"], [42.2, undefined],
  ];

  it.each(cases)("distance %s km, level %s: valid, Sunday-long, style-composable", (dist, level) => {
    const s = suggestPlanSessions(dist, level);
    expect(s.length).toBeGreaterThanOrEqual(3);
    // Minutes come from SessionConfigurator's fixed option set; unique days.
    s.forEach(x => expect(ALLOWED).toContain(x.minutes));
    expect(new Set(s.map(x => x.dayOffset)).size).toBe(s.length);
    // The Sunday session is strictly the longest (it becomes the long run).
    const sun = s.find(x => x.dayOffset === 6)!;
    s.filter(x => x.dayOffset !== 6).forEach(x => expect(x.minutes).toBeLessThan(sun.minutes));
    // Quality placement works without demotions: two spaced hard days exist
    // whenever there are ≥2 non-long days.
    const quality = s.filter(x => x.dayOffset !== 6).map(x => x.dayOffset);
    expect(pickHardDays(quality, 6, 2).length).toBe(Math.min(2, quality.length));
  });

  it("scales days with level and distance", () => {
    expect(suggestPlanSessions(42.2, "frequent")).toHaveLength(5);
    expect(suggestPlanSessions(42.2, "regular")).toHaveLength(4);
    expect(suggestPlanSessions(42.2, "none")).toHaveLength(3);
    expect(suggestPlanSessions(5, "frequent")).toHaveLength(4);
    expect(suggestPlanSessions(5, "occasional")).toHaveLength(3);
  });
});

describe("buildPlan level floor", () => {
  it("starts a self-reported frequent runner's long run high, capped at the peak", () => {
    const plan = buildPlan(raceDateInDays(140), 14400, DAYS5, 42.2, 0, { level: "frequent" });
    const firstLong = plan.weeks[0].sessions.find(s => s.type === "LONG")!;
    expect(Number(firstLong.km)).toBeGreaterThanOrEqual(10);
    const short = buildPlan(raceDateInDays(120), 2700, DAYS5, 10, 0, { level: "frequent" });
    expect(Number(short.weeks[0].sessions.find(s => s.type === "LONG")!.km))
      .toBeLessThanOrEqual(short.longRunPeakKm);
  });

  it("unknown levels contribute nothing", () => {
    expect(levelStartLongKm("elite")).toBe(0);
    expect(levelStartLongKm(null)).toBe(0);
  });
});

describe("interval prescriptions are internally coherent", () => {
  // The desc's rep workout must always FIT the shown session total — reps
  // derive from the day's time budget and the total is computed from them,
  // never clipped afterwards (same "5x800m" with two different totals was a
  // real user-reported confusion).
  const parseWork = (desc: string) => {
    const m = desc.match(/(\d+)x(\d+(?:\.\d+)?)(km|m)\b/);
    if (!m) return null;
    return Number(m[1]) * (m[3] === "km" ? Number(m[2]) : Number(m[2]) / 1000);
  };
  const layouts = [
    [{ dayOffset: 2, minutes: 30 }, { dayOffset: 6, minutes: 60 }],
    [{ dayOffset: 1, minutes: 45 }, { dayOffset: 3, minutes: 60 }, { dayOffset: 6, minutes: 90 }],
    DAYS5,
  ];

  it.each(["balanced", "polarized", "lowfreq", "hansons"])("%s", (style) => {
    layouts.forEach(layout => {
      const plan = buildPlan(raceDateInDays(140), 6600, layout, 21.1, 0, { style });
      let seen = 0;
      allSessions(plan).filter(s => s.type === "INTERVALS").forEach(s => {
        const work = parseWork(s.desc);
        expect(work).not.toBeNull();
        seen++;
        // Total ≥ the promised rep work, and total = work + a warmup/recovery
        // allowance of at most ~1.6 km (i.e. derived from the reps, not clipped).
        expect(Number(s.km)).toBeGreaterThanOrEqual(work! - 0.05);
        expect(Number(s.km) - work!).toBeLessThanOrEqual(1.6);
      });
      if (style !== "hansons" || layout.length > 2) expect(seen).toBeGreaterThan(0);
    });
  });
});

describe("style pacing table", () => {
  it("balanced keeps the pre-styles ratios", () => {
    expect(STYLE_PACING.balanced).toEqual({ easy: 1.25, tempo: 1.05, intervals: 1, long: 1.25, walk: null });
  });

  it("unknown styles degrade to balanced", () => {
    expect(stylePacing("norwegian-singles")).toEqual(STYLE_PACING.balanced);
    expect(stylePacing(undefined)).toEqual(STYLE_PACING.balanced);
  });

  it("every declared style has pacing", () => {
    STYLE_IDS.forEach(id => expect(STYLE_PACING[id as keyof typeof STYLE_PACING]).toBeTruthy());
  });
});

describe("buildPlan styles", () => {
  it("absent style is identical to explicit balanced", () => {
    const args = [raceDateInDays(120), 6340, DAYS3, 21.1, 150] as const;
    const a = buildPlan(...args, { recentRuns: [{ date: raceDateInDays(-7), km: 14 }] });
    const b = buildPlan(...args, { recentRuns: [{ date: raceDateInDays(-7), km: 14 }], style: "balanced" });
    expect(a).toEqual(b);
    expect(a.style).toBe("balanced");
  });

  it("unknown style degrades to balanced output", () => {
    const args = [raceDateInDays(120), 6340, DAYS3, 21.1, 0] as const;
    expect(buildPlan(...args, { style: "vaporware" })).toEqual(buildPlan(...args, {}));
  });

  describe("polarized", () => {
    const plan = buildPlan(raceDateInDays(120), 6340, DAYS5, 21.1, 0, { style: "polarized" });

    it("caps hard non-LONG work at one session per week", () => {
      trainingWeeks(plan).forEach(w => {
        const hard = w.sessions.filter(s => s.type === "TEMPO" || s.type === "INTERVALS");
        expect(hard.length).toBeLessThanOrEqual(1);
      });
    });

    it("prescribes genuinely easy pace on easy and long days", () => {
      const tgt = plan.targetPace;
      allSessions(plan).forEach(s => {
        if (s.type === "EASY" || s.type === "LONG")
          expect(s.pace).toBe(Math.round(tgt * 1.32));
      });
    });
  });

  describe("runwalk", () => {
    const plan = buildPlan(raceDateInDays(140), 14400, DAYS3, 42.2, 0, { style: "runwalk" });

    it("never emits tempo or interval sessions", () => {
      expect(allSessions(plan).some(s => s.type === "TEMPO" || s.type === "INTERVALS")).toBe(false);
    });

    it("uses WALK-typed sessions with the run/walk ratio in the desc", () => {
      const walks = allSessions(plan).filter(s => s.type === "WALK");
      expect(walks.length).toBeGreaterThan(0);
      walks.forEach(s => expect(s.desc).toMatch(/run \d min \/ walk 1 min/));
      allSessions(plan).filter(s => s.type === "LONG")
        .forEach(s => expect(s.desc).toMatch(/Long run\/walk/));
    });

    it("caps the marathon long run at 26 km (finish-focused)", () => {
      expect(plan.longRunPeakKm).toBeLessThanOrEqual(26);
    });

    it("includes cutback weeks in the long-run ramp", () => {
      const longs = trainingWeeks(plan)
        .flatMap(w => w.sessions).filter(s => s.type === "LONG").map(s => Number(s.km));
      const dips = longs.filter((km, i) => i > 0 && i < longs.length - 1 && km < longs[i - 1]);
      expect(dips.length).toBeGreaterThan(0);
    });

    it("prescribes WALK days at the shared walk pace and backs the ratio off in taper", () => {
      const tgt = plan.targetPace;
      allSessions(plan).filter(s => s.type === "WALK")
        .forEach(s => expect(s.pace).toBe(Math.round(tgt * 1.45)));
      const byPhase = (phase: string) => trainingWeeks(plan)
        .filter(w => w.phase === phase).flatMap(w => w.sessions);
      // Taper never carries the plan's most aggressive run/walk ratio.
      byPhase("PEAK").forEach(s => expect(s.desc).toMatch(/run 3 min/));
      byPhase("TAPER").forEach(s => expect(s.desc).toMatch(/run 2 min/));
    });
  });

  describe("lowfreq", () => {
    const plan = buildPlan(raceDateInDays(120), 6340, DAYS5, 21.1, 0, { style: "lowfreq" });

    it("keeps exactly 3 run days; extra days become optional cross-training", () => {
      trainingWeeks(plan).forEach(w => {
        const runs = w.sessions.filter(s => ["EASY", "TEMPO", "INTERVALS", "LONG"].includes(s.type));
        const other = w.sessions.filter(s => s.type === "OTHER");
        expect(runs.length).toBeLessThanOrEqual(3);
        expect(other.length).toBe(w.sessions.length - runs.length);
        other.forEach(s => expect(s.desc).toMatch(/cross-training/i));
      });
    });

    it("prescribes faster interval pace than balanced", () => {
      const tgt = plan.targetPace;
      const ints = allSessions(plan).filter(s => s.type === "INTERVALS");
      expect(ints.length).toBeGreaterThan(0);
      ints.forEach(s => expect(s.pace).toBe(Math.round(tgt * 0.95)));
    });

    it("degrades to long + alternating quality with only 2 days", () => {
      const two = buildPlan(raceDateInDays(120), 6340,
        [{ dayOffset: 2, minutes: 45 }, { dayOffset: 6, minutes: 90 }], 21.1, 0, { style: "lowfreq" });
      const types = new Set(allSessions(two).map(s => s.type));
      expect(types.has("OTHER")).toBe(false);
      expect(types.has("TEMPO") && types.has("INTERVALS")).toBe(true);
    });

    it("degrades to long-run only with a single day", () => {
      const one = buildPlan(raceDateInDays(120), 6340,
        [{ dayOffset: 6, minutes: 90 }], 21.1, 0, { style: "lowfreq" });
      const types = new Set(allSessions(one).map(s => s.type));
      expect(types).toEqual(new Set(["LONG"]));
    });
  });

  describe("hansons", () => {
    const plan = buildPlan(raceDateInDays(140), 14400, DAYS5, 42.2, 0,
      { style: "hansons", recentRuns: [{ date: raceDateInDays(-7), km: 20 }] });

    it("caps the marathon long run at 26 km", () => {
      expect(plan.longRunPeakKm).toBeLessThanOrEqual(26);
    });

    it("keeps the long run under ~35% of peak-week volume", () => {
      const peakWeek = trainingWeeks(plan).reduce((best, w) => {
        const vol = w.sessions.reduce((s, x) => s + Number(x.km), 0);
        return vol > best.vol ? { vol, w } : best;
      }, { vol: 0, w: trainingWeeks(plan)[0] });
      const long = peakWeek.w.sessions.find(s => s.type === "LONG");
      expect(Number(long!.km) / peakWeek.vol).toBeLessThanOrEqual(0.35);
    });

    it("prescribes the tempo at goal race pace", () => {
      const tempos = allSessions(plan).filter(s => s.type === "TEMPO");
      expect(tempos.length).toBeGreaterThan(0);
      tempos.forEach(s => {
        expect(s.pace).toBe(plan.targetPace);
        expect(s.desc).toMatch(/goal race pace/);
      });
    });

    it("keeps the long run volume-bounded even on tiny configs (no 12 km floor)", () => {
      // 2 short days for a half: ~13 km/week of budget. A hard 12 km floor
      // would make the long run nearly the whole week; the volume-bounded
      // floor keeps it a moderate share.
      const tiny = buildPlan(raceDateInDays(120), 6600,
        [{ dayOffset: 2, minutes: 40 }, { dayOffset: 6, minutes: 40 }], 21.1, 0, { style: "hansons" });
      expect(tiny.longRunPeakKm).toBeLessThan(8);
    });

    it("never places two hard sessions on consecutive days", () => {
      const hard = allSessions(plan)
        .filter(s => ["TEMPO", "INTERVALS", "LONG"].includes(s.type))
        .map(s => s.date).sort();
      for (let i = 1; i < hard.length; i++) {
        const gap = (new Date(hard[i] + "T00:00:00").getTime()
          - new Date(hard[i - 1] + "T00:00:00").getTime()) / 86400000;
        expect(gap).toBeGreaterThanOrEqual(2);
      }
    });
  });
});
