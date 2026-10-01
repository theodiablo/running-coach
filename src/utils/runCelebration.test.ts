import { describe, expect, it } from "vitest";
import copy from "../i18n/locales/en/celebration.json";
import { buildCelebration, celebrationFacts, isNegativeSplit, RARE_CHANCE, type Celebration, type CelebrationInput } from "./runCelebration";
import type { TrackPointOrGap } from "./geo";
import type { Run } from "../types";

const DAY = "2026-09-16"; // a Wednesday
const at = new Date(DAY + "T12:00:00");
const mid = () => 0.5;

const daysBefore = (n: number) => {
  const d = new Date(DAY + "T00:00:00");
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};
// `n` prior runs, newest first, one every other day.
const history = (n: number, over: Partial<Run> = {}): Run[] =>
  Array.from({ length: n }, (_, i) => ({ id: "p" + i, date: daysBefore(2 + i * 2), type: "EASY", km: 6, durationSec: 2160, ...over }));

// 6 km: covers no standard distance, so the baseline is never a best effort.
const run = (over: Partial<Run> = {}): Run => ({ date: DAY, type: "EASY", km: 6, durationSec: 2160, source: "gps", ...over });
const input = (over: Partial<CelebrationInput> = {}): CelebrationInput => ({ run: run(), runs: history(6), at, rand: mid, ...over });
const build = (over: Partial<CelebrationInput> = {}) => buildCelebration(input(over)) as Celebration;
const families = (over: Partial<CelebrationInput> = {}) => celebrationFacts(input(over)).map(f => f.key);

// Every {{slot}} in a resolved key has a value to fill it.
function expectFilled(c: Celebration) {
  if (!c.fact) return;
  const text = c.fact.key.split(".").slice(1).reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], copy) as string;
  for (const [, slot] of text.matchAll(/\{\{(\w+)\}\}/g)) expect(c.fact.vars, `${c.fact.key} needs ${slot}`).toHaveProperty(slot);
}

describe("buildCelebration", () => {
  it("stays quiet for an accidental recording", () => {
    expect(buildCelebration(input({ run: run({ km: 0.05, durationSec: 40 }) }))).toBeNull();
    expect(buildCelebration(input({ run: run({ type: "OTHER", km: 0, durationSec: 30 }) }))).toBeNull();
  });

  it("marks the very first run, with confetti", () => {
    const c = build({ runs: [] });
    expect(c.fact?.key).toMatch(/^celebration\.fact\.first\./);
    expect(c.confetti).toBe(true);
  });

  it("leads with a personal-best headline and carries the effort rows", () => {
    const c = build({ runs: history(4, { bestEfforts: { "5k": 1800 } }), run: run({ bestEfforts: { "5k": 1700 } }) });
    expect(c.headline).toMatch(/^celebration\.head\.pb\./);
    expect(c.efforts[0]).toMatchObject({ key: "5k", rank: 1 });
    expect(c.confetti).toBe(true);
  });

  it("calls a run the longest only against enough history", () => {
    expect(families({ run: run({ km: 10, durationSec: 3600 }) })).toContain("longest");
    expect(families({ run: run({ km: 10, durationSec: 3600 }), runs: history(2) })).not.toContain("longest");
    const c = build({ run: run({ km: 10.04, durationSec: 3600 }) });
    expect(c.fact?.key).toMatch(/^celebration\.fact\.longest\./);
    expect(c.fact?.vars.km).toBe("10");
    expectFilled(c);
  });

  it("measures the longest by time when it isn't the longest by distance", () => {
    expect(families({ run: run({ durationSec: 2700 }) })).toEqual(expect.arrayContaining(["longestTime"]));
  });

  it("finds the longest in recent weeks without claiming all-time", () => {
    const runs = [...history(4), { id: "old", date: daysBefore(120), type: "LONG", km: 20, durationSec: 7200 }];
    const f = families({ run: run({ km: 8, durationSec: 2700 }), runs });
    expect(f).toContain("recentLongest");
    expect(f).not.toContain("longest");
  });

  it("keeps a short run gentle", () => {
    const c = build({ run: run({ km: 0.8, durationSec: 280 }) });
    expect(c.headline).toMatch(/^celebration\.head\.short\./);
    expect(c.fact).toBeNull();
  });

  it("welcomes the runner back after a break, without guilt", () => {
    const runs = history(4).map(r => ({ ...r, date: daysBefore(20 + Number(r.id!.slice(1))) }));
    const c = build({ runs });
    expect(c.fact?.key).toMatch(/^celebration\.fact\.comeback\./);
    expect(c.fact?.vars.days).toBe(20);
    expectFilled(c);
  });

  it("marks round run counts and lifetime distance", () => {
    expect(families({ runs: history(9) })).toContain("count");
    expect(families({ runs: history(8) })).not.toContain("count");
    const runs = history(16); // 96 km
    const total = celebrationFacts(input({ runs })).find(f => f.key === "total");
    expect(total?.vars.km).toBe(100);
    expect(families({ runs: history(39, { km: 50 }), run: run({ km: 60, durationSec: 20000 }) })).toContain("total");
  });

  it("only calls a pace quicker against the runner's own similar runs", () => {
    expect(families({ run: run({ durationSec: 1980 }) })).toContain("quicker");
    expect(families({ run: run({ durationSec: 2140 }) })).not.toContain("quicker");
    expect(families({ run: run({ durationSec: 1980 }), runs: history(4) })).not.toContain("quicker");
  });

  it("notices a new climbing high and the biggest week", () => {
    const runs = history(6, { elevation: 40 });
    expect(families({ runs, run: run({ elevation: 120 }) })).toContain("climb");
    const quiet = history(12, { km: 2, durationSec: 720 });
    const big = celebrationFacts(input({ runs: quiet, run: run({ km: 8, durationSec: 2880 }) })).find(f => f.key === "week");
    expect(big?.vars.km).toBe("10");
  });

  it("names the plan session the run settled", () => {
    const session = { id: "w2d3", date: DAY, type: "TEMPO", desc: "", km: 6, pace: 300 };
    const c = build({ session, runs: history(6) });
    expect(c.fact?.key).toBe("celebration.fact.session.TEMPO");
  });

  it("celebrates an indoor session in its own words", () => {
    const indoor = run({ type: "OTHER", km: 0, durationSec: 2400, source: "indoor" });
    const c = build({ run: indoor });
    expect(c.headline).toMatch(/^celebration\.head\.indoor\./);
    expect(c.efforts).toEqual([]);
    expect(c.fact?.key).toBe("celebration.fact.indoorFirst.a");
    const sessions = history(3, { type: "OTHER", km: 0, durationSec: 1800 });
    const longest = build({ run: indoor, runs: sessions });
    expect(longest.fact?.key).toMatch(/^celebration\.fact\.indoorLongest\./);
    expectFilled(longest);
  });

  it("draws a headline that wasn't shown recently", () => {
    const all = Object.keys(copy.head.run).map(k => `celebration.head.run.${k}`);
    const recent = all.filter(k => k !== "celebration.head.run.r7");
    expect(build({ recent }).headline).toBe("celebration.head.run.r7");
    // With everything recent, still draws rather than going blank.
    expect(build({ recent: all }).headline).toMatch(/^celebration\.head\.run\./);
  });

  it("uses early and late headlines by the start time", () => {
    const low = () => 0.2; // not rare, but takes the time-of-day branch
    expect(build({ at: new Date(DAY + "T06:10:00"), rand: low }).headline).toMatch(/^celebration\.head\.early\./);
    expect(build({ at: new Date(DAY + "T22:30:00"), rand: low }).headline).toMatch(/^celebration\.head\.night\./);
    expect(build({ at: new Date(DAY + "T12:00:00"), rand: low }).headline).toMatch(/^celebration\.head\.run\./);
  });

  it("very occasionally draws a rare one, but never over a personal best", () => {
    const lucky = () => RARE_CHANCE / 2;
    const c = build({ rand: lucky });
    expect(c.rare).toBe(true);
    expect(c.headline).toMatch(/^celebration\.head\.rare\./);
    expect(c.confetti).toBe(true);
    expect(build().rare).toBe(false);
    const pb = build({ rand: lucky, runs: history(4, { bestEfforts: { "5k": 1800 } }), run: run({ bestEfforts: { "5k": 1700 } }) });
    expect(pb.rare).toBe(false);
  });
});

// A straight line north, one fix per 100 m, at the given pace per km.
function track(paces: number[]): TrackPointOrGap[] {
  const pts: TrackPointOrGap[] = [];
  let t = 0;
  pts.push([45, 5, t, null]);
  paces.forEach((pace, k) => {
    for (let i = 1; i <= 10; i++) {
      t += pace * 100;
      pts.push([45 + (k * 10 + i) * 0.0008993, 5, t, null]);
    }
  });
  return pts;
}

describe("isNegativeSplit", () => {
  it("sees a quicker second half", () => {
    expect(isNegativeSplit(track([360, 360, 360, 330, 330, 330]))).toBe(true);
  });
  it("makes no claim on an even run or a positive split", () => {
    expect(isNegativeSplit(track([330, 330, 330, 330, 330, 330]))).toBe(false);
    expect(isNegativeSplit(track([330, 330, 330, 360, 360, 360]))).toBe(false);
  });
  it("makes no claim when a stop distorts a split", () => {
    expect(isNegativeSplit(track([360, 900, 360, 330, 330, 330]))).toBe(false);
  });
  it("needs four whole kilometres", () => {
    expect(isNegativeSplit(track([360, 330, 300]))).toBe(false);
  });
});
