import { describe, it, expect } from "vitest";
import { validatePlan, formatValidation } from "./coachValidation";
import { buildPlan } from "./plan";
import { ymd } from "./format";

type TestSession = {
  id: string;
  date: string;
  type: string;
  km: number;
  pace: number;
  done: boolean;
  skipped?: boolean;
  [key: string]: unknown;
};
type TestWeek = { weekNumber: number; startDate: string; phase: string; sessions: TestSession[] };
type TestPlan = {
  raceDate: string;
  distanceKm: number;
  goalSec: number;
  targetPace: number;
  planSessions: unknown[];
  weeks: TestWeek[];
};
type ValidationIssue = { code: string; weekNumber?: number; sessionId?: string; preexisting?: boolean };
type ValidationResult = { ok: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] };

// The hand-crafted fixtures below live on a fixed calendar, so the validator
// gets a fixed `today` to match: the load rules skip weeks that have already
// elapsed, and without pinning it the whole fixture would silently age out of
// them once the real date passed 2026-02. Tests about elapsed weeks override it.
const TODAY = "2026-01-05";
const validate = (plan: unknown, opts: Record<string, unknown> = {}) =>
  validatePlan(plan, { today: TODAY, ...opts }) as ValidationResult;

// ── hand-crafted fixture ──────────────────────────────────────────────────────
// 6 weeks, Mondays from 2026-01-05, race Sat 2026-02-14. Volumes ramp gently,
// hard days are Wed/Sun, taper sheds volume — a plan that should be clean.
const sess = (id: string, date: string, type: string, km: number, extra: Partial<TestSession> = {}): TestSession =>
  ({ id, date, type, km, pace: 360, done: false, ...extra });
const wk = (weekNumber: number, startDate: string, phase: string, sessions: TestSession[]): TestWeek => ({ weekNumber, startDate, phase, sessions });

const cleanPlan = (): TestPlan => ({
  raceDate: "2026-02-14", distanceKm: 20, goalSec: 6600, targetPace: 330, planSessions: [],
  weeks: [
    wk(1, "2026-01-05", "BASE", [sess("w1d2", "2026-01-07", "EASY", 4), sess("w1d6", "2026-01-11", "LONG", 8)]),
    wk(2, "2026-01-12", "BUILD", [sess("w2d2", "2026-01-14", "EASY", 4), sess("w2d6", "2026-01-18", "LONG", 9)]),
    wk(3, "2026-01-19", "BUILD", [sess("w3d2", "2026-01-21", "TEMPO", 5), sess("w3d6", "2026-01-25", "LONG", 10)]),
    wk(4, "2026-01-26", "PEAK", [sess("w4d2", "2026-01-28", "INTERVALS", 5), sess("w4d6", "2026-02-01", "LONG", 11)]),
    wk(5, "2026-02-02", "TAPER", [sess("w5d2", "2026-02-04", "EASY", 3), sess("w5d6", "2026-02-08", "LONG", 6)]),
    wk(6, "2026-02-09", "RACE", [sess("race", "2026-02-14", "RACE", 20)]),
  ],
});

describe("validatePlan rules", () => {
  it("passes a clean plan", () => {
    const r = validate(cleanPlan());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("rejects malformed plans and sessions", () => {
    expect(validate(null).ok).toBe(false);
    expect(validate({ raceDate: "2026-02-14", weeks: [] }).ok).toBe(false);
    const p = cleanPlan();
    p.weeks[0]!.sessions[0]!.type = "JOG";
    const r = validate(p);
    expect(r.errors.some(e => e.code === "MALFORMED")).toBe(true);
  });

  it("flags hard sessions on consecutive days", () => {
    const p = cleanPlan();
    p.weeks[2]!.sessions[0]!.date = "2026-01-24"; // TEMPO the day before Sunday's LONG
    const r = validate(p);
    expect(r.errors.some(e => e.code === "HARD_BACK_TO_BACK")).toBe(true);
  });

  it("skipped sessions contribute no load: spacing, taper and ramp ignore them", () => {
    // A skipped TEMPO the day before the LONG is not a hard back-to-back —
    // it will not be run.
    const p = cleanPlan();
    p.weeks[2]!.sessions[0]!.date = "2026-01-24";
    p.weeks[2]!.sessions[0]!.skipped = true;
    expect(validate(p).errors.some(e => e.code === "HARD_BACK_TO_BACK")).toBe(false);
    // Skipped intervals inside the final 14 days don't trip the taper rule.
    const q = cleanPlan();
    q.weeks[4]!.sessions[0]!.type = "INTERVALS";
    q.weeks[4]!.sessions[0]!.skipped = true;
    expect(validate(q).errors.some(e => e.code === "TAPER_INTERVALS")).toBe(false);
    // A big session that is skipped doesn't count toward the weekly ramp.
    const r = cleanPlan();
    r.weeks[2]!.sessions[1]!.km = 25;
    r.weeks[2]!.sessions[1]!.skipped = true;
    expect(validate(r).errors.some(e => e.code === "RAMP_EXCEEDED")).toBe(false);
  });

  it("ramp still gates a jump above pre-layoff volume when the two prior weeks are fully skipped", () => {
    // Weeks 2 and 3 fully skipped (a two-week layoff). Skipped km reads as 0,
    // so a naive two-week reference would collapse to 0 and un-gate the ramp.
    // Resuming week 4 near the pre-layoff level is fine, but jumping well above
    // it is still "making up volume" — the reference walks back to week 1.
    const base = cleanPlan();
    for (const s of base.weeks[1]!.sessions) s.skipped = true; // week 2 → 0 km
    for (const s of base.weeks[2]!.sessions) s.skipped = true; // week 3 → 0 km
    expect(validate(base).errors.some(e => e.code === "RAMP_EXCEEDED")).toBe(false);

    const jump = structuredClone(base);
    jump.weeks[3]!.sessions[1]!.km = 20; // week 4 → 25 km vs week 1's 12 km
    expect(validate(jump).errors.some(e => e.code === "RAMP_EXCEEDED" && e.weekNumber === 4)).toBe(true);
  });

  it("flags a week-over-week volume jump", () => {
    const p = cleanPlan();
    p.weeks[2]!.sessions[1]!.km = 25; // week 3: 30 km after 13 km
    const r = validate(p);
    expect(r.errors.some(e => e.code === "RAMP_EXCEEDED" && e.weekNumber === 3)).toBe(true);
  });

  it("guards the taper: no intervals in the final 14 days, tempo in the final 7", () => {
    const p = cleanPlan();
    p.weeks[4]!.sessions[0]!.type = "INTERVALS"; // 2026-02-04, 10 days out
    expect(validate(p).errors.some(e => e.code === "TAPER_INTERVALS")).toBe(true);
    const q = cleanPlan();
    q.weeks[5]!.sessions.unshift(sess("w6d1", "2026-02-10", "TEMPO", 5)); // 4 days out
    expect(validate(q).errors.some(e => e.code === "TAPER_TEMPO")).toBe(true);
  });

  it("keeps the final weeks below peak volume", () => {
    const p = cleanPlan();
    p.weeks[4]!.sessions[1]!.km = 15; // taper week back at 18 km vs 16 km peak
    expect(validate(p).errors.some(e => e.code === "TAPER_VOLUME")).toBe(true);
  });

  // ── elapsed weeks ────────────────────────────────────────────────────────
  // A rebuild keeps the weeks that have already been lived. They are the
  // training record, and the coach has no tool that can touch a past date — so
  // a load error raised on one is unfixable, and one unfixable error would
  // block every proposal that runner ever asks for.
  describe("weeks that have already elapsed", () => {
    // Week 3 (starting 2026-01-19) has ended by this date; weeks 4-6 have not.
    const AFTER_WEEK_3 = "2026-01-27";

    it("never raises a ramp error on a week that has already elapsed", () => {
      const p = cleanPlan();
      p.weeks[2]!.sessions[1]!.km = 25; // the same jump the live-week test flags
      expect(validate(p).errors.some(e => e.code === "RAMP_EXCEEDED" && e.weekNumber === 3)).toBe(true);
      expect(validate(p, { today: AFTER_WEEK_3 }).errors.some(e => e.code === "RAMP_EXCEEDED")).toBe(false);
    });

    it("does not let an elapsed week's hard days raise a spacing error", () => {
      const p = cleanPlan();
      p.weeks[2]!.sessions[0]!.date = "2026-01-24";
      expect(validate(p).errors.some(e => e.code === "HARD_BACK_TO_BACK")).toBe(true);
      expect(validate(p, { today: AFTER_WEEK_3 }).errors.some(e => e.code === "HARD_BACK_TO_BACK")).toBe(false);
    });

    // The other half of the split: an elapsed week is never the SUBJECT of an
    // error, but it is still the REFERENCE the live weeks are measured against.
    it("measures the taper against the peak the runner actually ran", () => {
      const p = cleanPlan();
      p.weeks[2]!.sessions[1]!.km = 40; // elapsed week 3 is the real peak, 45 km
      p.weeks[4]!.sessions[1]!.km = 15; // taper week at 18 km — a genuine taper off 45
      // Scored over the live weeks alone the peak collapses to 16 km and this
      // reads as "not tapering", which is the false positive to avoid: late in
      // a plan almost every week that set the peak has already been run.
      expect(validate(p, { today: AFTER_WEEK_3 }).errors.some(e => e.code === "TAPER_VOLUME")).toBe(false);
    });

    it("still fires the taper guard on a live week that has not shed volume", () => {
      const p = cleanPlan();
      p.weeks[4]!.sessions[1]!.km = 15; // 18 km against a 16 km peak
      expect(validate(p, { today: AFTER_WEEK_3 }).errors.some(e => e.code === "TAPER_VOLUME")).toBe(true);
    });

    it("keeps the ramp reference on pre-layoff volume, so a live week can still be flagged", () => {
      const p = cleanPlan();
      p.weeks[3]!.sessions[1]!.km = 40; // live week 4 jumps to 45 km off 15 km
      const r = validate(p, { today: AFTER_WEEK_3 });
      expect(r.errors.some(e => e.code === "RAMP_EXCEEDED" && e.weekNumber === 4)).toBe(true);
    });

    it("still applies every load rule to the weeks that are still ahead", () => {
      const p = cleanPlan();
      p.weeks[4]!.sessions[0]!.type = "INTERVALS"; // taper week, 10 days out
      const r = validate(p, { today: AFTER_WEEK_3 });
      expect(r.errors.some(e => e.code === "TAPER_INTERVALS")).toBe(true);
    });

    it("still checks the structure of an elapsed week", () => {
      const p = cleanPlan();
      p.weeks[0]!.sessions[0]!.type = "JOG";
      expect(validate(p, { today: AFTER_WEEK_3 }).errors.some(e => e.code === "MALFORMED")).toBe(true);
    });
  });

  it("rejects training sessions on/after race day, allows the race itself", () => {
    const p = cleanPlan();
    p.weeks[5]!.sessions.push(sess("w6d5", "2026-02-14", "EASY", 3));
    expect(validate(p).errors.some(e => e.code === "AFTER_RACE")).toBe(true);
  });

  it("waives errors that exist identically in the baseline — but not new ones", () => {
    const baseline = cleanPlan();
    baseline.weeks[2]!.sessions[0]!.date = "2026-01-24"; // pre-existing back-to-back
    const proposal = structuredClone(baseline);
    const r = validate(proposal, { baseline });
    expect(r.ok).toBe(true);
    expect(r.warnings.some(w => w.code === "HARD_BACK_TO_BACK" && w.preexisting)).toBe(true);
    // A NEW violation elsewhere still blocks.
    proposal.weeks[3]!.sessions[0]!.date = "2026-01-31"; // INTERVALS day before LONG
    expect(validate(proposal, { baseline }).ok).toBe(false);
  });

  it("does not waive a changed hard back-to-back pairing for the same later session", () => {
    const baseline = cleanPlan();
    baseline.weeks[2]!.sessions[0]!.date = "2026-01-24"; // TEMPO before Sunday's LONG
    const proposal = structuredClone(baseline);
    proposal.weeks[2]!.sessions[0]!.date = "2026-01-21";
    proposal.weeks[2]!.sessions.unshift(sess("new-hard", "2026-01-24", "INTERVALS", 4));

    const r = validate(proposal, { baseline });

    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.code === "HARD_BACK_TO_BACK" && e.sessionId === "w3d6")).toBe(true);
  });

  it("formatValidation renders codes and messages", () => {
    const p = cleanPlan();
    p.weeks[2]!.sessions[1]!.km = 25;
    expect(formatValidation(validate(p))).toContain("RAMP_EXCEEDED");
    expect(formatValidation(validate(cleanPlan()))).toBe("Plan is valid.");
  });
});

// ── one validator, two callers: the deterministic generator must pass too ────
describe("buildPlan output passes the shared validator", () => {
  const weeksOut = (n: number) => {
    const d = new Date(); d.setDate(d.getDate() + n * 7);
    return ymd(d);
  };
  const seedRuns = (longest: number) => [
    { id: "r1", date: ymd(new Date(Date.now() - 5 * 86400000)), type: "LONG", km: longest, durationSec: longest * 360 },
    { id: "r2", date: ymd(new Date(Date.now() - 12 * 86400000)), type: "EASY", km: longest * 0.6, durationSec: longest * 0.6 * 380 },
  ];
  const sessions = [{ dayOffset: 2, minutes: 45 }, { dayOffset: 6, minutes: 90 }];

  const cases: [string, string, number, number, number, object][] = [
    ["10k, 12 weeks, from scratch", weeksOut(12), 3000, 10, 0, {}],
    ["half, 16 weeks, from scratch", weeksOut(16), 6600, 21.1, 150, {}],
    ["marathon, 20 weeks, fit runner", weeksOut(20), 14400, 42.2, 300, { recentRuns: seedRuns(18) }],
    ["marathon, 16 weeks, fit runner", weeksOut(16), 14400, 42.2, 0, { recentRuns: seedRuns(22) }],
    ["distant race (>24w cap)", weeksOut(40), 6600, 21.1, 0, {}],
  ];

  it.each(cases)("%s", (_label, raceDate, goalSec, distanceKm, elev, opts) => {
    const plan = buildPlan(raceDate, goalSec, sessions, distanceKm, elev, opts);
    const r = validate(plan);
    expect(r.errors).toEqual([]);
  });

  // Every methodology style must produce validator-clean plans across the
  // realistic envelope: race distances, day counts (incl. adversarial
  // consecutive-day layouts) and fitness levels.
  const dayLayouts: [string, { dayOffset: number; minutes: number }[]][] = [
    ["2 days", [{ dayOffset: 2, minutes: 30 }, { dayOffset: 6, minutes: 60 }]],
    ["3 days", [{ dayOffset: 1, minutes: 40 }, { dayOffset: 3, minutes: 45 }, { dayOffset: 6, minutes: 90 }]],
    ["4 days", [{ dayOffset: 0, minutes: 40 }, { dayOffset: 2, minutes: 45 }, { dayOffset: 4, minutes: 40 }, { dayOffset: 6, minutes: 100 }]],
    ["6 days", [{ dayOffset: 0, minutes: 40 }, { dayOffset: 1, minutes: 45 }, { dayOffset: 2, minutes: 60 }, { dayOffset: 3, minutes: 40 }, { dayOffset: 4, minutes: 45 }, { dayOffset: 6, minutes: 110 }]],
    ["consecutive days", [{ dayOffset: 4, minutes: 45 }, { dayOffset: 5, minutes: 45 }, { dayOffset: 6, minutes: 90 }]],
  ];
  const raceCases: [string, string, number, number, object][] = [
    ["5k, 10 weeks, unfit", weeksOut(10), 1500, 5, {}],
    ["10k, 12 weeks", weeksOut(12), 3000, 10, {}],
    ["half, 16 weeks, fit", weeksOut(16), 6600, 21.1, { recentRuns: seedRuns(14) }],
    ["marathon, 20 weeks, fit", weeksOut(20), 14400, 42.2, { recentRuns: seedRuns(18) }],
    // Self-reported level, no history: the onboarding path's higher week-1 start.
    ["marathon, 20 weeks, frequent (self-reported)", weeksOut(20), 14400, 42.2, { level: "frequent" }],
  ];
  const styles = ["balanced", "polarized", "runwalk", "lowfreq", "hansons"];

  describe.each(styles)("style %s is validator-clean", (style) => {
    // Balanced with user-picked adjacent days has a PRE-EXISTING back-to-back
    // exposure (frozen by the snapshot tests, waived via the validator's
    // baseline mechanism); only the new styles guarantee clean output on
    // dense/adversarial layouts, so balanced runs the sparse layouts only.
    const layouts = style === "balanced" ? dayLayouts.slice(0, 2) : dayLayouts;
    it.each(raceCases.flatMap(([rLabel, raceDate, goalSec, distanceKm, opts]) =>
      layouts.map(([dLabel, layout]) =>
        [`${rLabel}, ${dLabel}`, raceDate, goalSec, distanceKm, layout, opts] as const)))(
      "%s", (_label, raceDate, goalSec, distanceKm, layout, opts) => {
        const plan = buildPlan(raceDate, goalSec, layout, distanceKm, 0, { ...opts, style });
        expect(validate(plan).errors).toEqual([]);
      });
  });

  it("flags an unsafe crash plan (marathon in 6 weeks from scratch) — by design", () => {
    // The generator will happily build this; the validator disagrees. Safety >
    // consistency: the agent can still operate on such a plan via the baseline
    // waiver, but may never make it worse.
    const plan = buildPlan(weeksOut(6), 14400, sessions, 42.2, 0, {});
    const r = validate(plan);
    expect(r.ok).toBe(false);
    expect(validate(plan, { baseline: plan }).ok).toBe(true);
  });
});
