import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildPlan } from "./plan";
import { planPhase } from "./planPhase";
import { buildOpenPlan, raceKey } from "./openPlan";
import { ymd } from "./format";
import {
  FASTER_OPTIONS, SUGGEST_MAX_DAYS, SUGGEST_MIN_DAYS, bestSecByKey, goalOrder, raceSuggestions, whatsNextDue, wishlistLead,
} from "./whatsNext";
import type { JoinedEdition, Participation, Plan, Run, SettingsState } from "../types";
import type { PlanSessionInput } from "./plan";

const TODAY = "2026-10-20";
const day = (n: number, from = TODAY) => ymd(new Date(new Date(from + "T00:00:00").getTime() + n * 86400000));
const SESSIONS: PlanSessionInput[] = [{ dayOffset: 2, minutes: 45 }, { dayOffset: 6, minutes: 90 }];

describe("goalOrder", () => {
  it("orders the goals by how the runner feels", () => {
    expect(goalOrder("fired", "afterRace")).toEqual(["race", "improve"]);
    expect(goalOrder("steady", "afterRace")).toEqual(["improve", "race"]);
    expect(goalOrder("breather", "afterRace")).toEqual(["lighter", "improve"]);
  });

  it("the race-first variant leads with races whatever the feeling", () => {
    for (const f of ["fired", "steady", "breather", null] as const) expect(goalOrder(f, "raceFirst")).toEqual(["race", "improve"]);
  });
});

describe("race suggestions", () => {
  const ed = (id: string, daysOut: number, km: number, lat?: number, lng?: number) => ({
    name: id, raceId: id, id, lat, lng, edition: { id, date: day(daysOut), distanceKm: km },
  }) as unknown as JoinedEdition;
  const near = (listed: Participation[] = [], loc: { lat: number; lng: number } | null = null, km = 10) =>
    raceSuggestions([
      ed("too-soon", SUGGEST_MIN_DAYS - 1, 10), ed("too-far", SUGGEST_MAX_DAYS + 1, 10), ed("half", 70, 21.1),
      ed("c", 100, 10, 40, -3), ed("a", 60, 10, 48, 2), ed("b", 80, 10, 41, -3.5), ed("d", 90, 10), ed("e", 95, 10),
    ], { today: TODAY, km, listed, loc });

  it("keeps 6 to 24 weeks out, near the distance, soonest first, top three", () => {
    expect(near().map(s => s.e.edition.id)).toEqual(["a", "b", "d"]);
  });

  it("nearest first when the runner's position is known", () => {
    const hits = near([], { lat: 40.4, lng: -3.7 });
    expect(hits.map(s => s.e.edition.id)).toEqual(["b", "c", "a"]);
    expect(hits[0].distM).not.toBeNull();
  });

  it("skips what is already on the list, and takes any standard distance when none was raced", () => {
    expect(near([{ editionId: "a" } as Participation]).map(s => s.e.edition.id)).toEqual(["b", "d", "e"]);
    expect(near([], null, 0).map(s => s.e.edition.id)).toContain("half");
  });

  it("a wishlisted race leads only with three weeks to train", () => {
    const part = (id: string, daysOut: number) => ({ editionId: id, status: "wishlist", raceDate: day(daysOut), distanceKm: 10, label: id }) as Participation;
    expect(wishlistLead([part("soon", 10), part("later", 40)], TODAY)?.editionId).toBe("later");
    expect(wishlistLead([part("soon", 10)], TODAY)).toBeNull();
  });
});

describe("when the sheet shows by itself", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-17T09:00:00")); });
  afterEach(() => vi.useRealTimers());

  const raceDate = "2026-10-04";
  const settled = () => {
    const p = buildPlan(raceDate, 3000, SESSIONS, 10, 0, { recovery: true }) as unknown as Plan;
    return { ...p, weeks: p.weeks.map(w => ({ ...w, sessions: w.sessions.map(s => s.id === "race" ? { ...s, done: true, runId: "r" } : s) })) } as Plan;
  };
  const info = (plan: Plan, today: string) =>
    planPhase({ plan, settings: { raceDate } as unknown as SettingsState, participations: [], runs: [] }, today);

  it("once the race is settled and the recovery is over, within 28 days plus the recovery", () => {
    const plan = settled();
    const until = plan.recovery!.until;
    const key = raceKey({ editionId: null, date: raceDate });
    expect(whatsNextDue(info(plan, day(1, raceDate)), plan, undefined, day(1, raceDate))).toBe(false);
    expect(whatsNextDue(info(plan, day(1, until)), plan, undefined, day(1, until))).toBe(true);
    const span = Math.round((new Date(until + "T00:00:00").getTime() - new Date(raceDate + "T00:00:00").getTime()) / 86400000);
    const last = day(28 + span, raceDate);
    expect(whatsNextDue(info(plan, last), plan, undefined, last)).toBe(true);
    expect(whatsNextDue(info(plan, day(1, last)), plan, undefined, day(1, last))).toBe(false);
    expect(whatsNextDue(info(plan, day(1, until)), plan, key, day(1, until))).toBe(false);
  });

  it("never for a plan with no race", () => {
    vi.setSystemTime(new Date("2026-09-16T09:00:00"));
    const plan = buildOpenPlan({ planSessions: SESSIONS } as unknown as SettingsState, { target: "healthy", distanceKm: 10 }, { runs: [] });
    expect(whatsNextDue(info(plan, TODAY), plan, undefined, TODAY)).toBe(false);
  });
});

describe("best efforts for the faster-at options", () => {
  it("is the fastest per distance across the log", () => {
    const runs = [
      { id: "a", date: "2026-10-01", type: "EASY", km: 5, durationSec: 1500 },
      { id: "b", date: "2026-10-02", type: "EASY", km: 5, durationSec: 1400 },
      { id: "c", date: "2026-10-03", type: "EASY", km: 10.1, durationSec: 3100, bestEfforts: { "10k": 3070 } },
    ] as unknown as Run[];
    const best = bestSecByKey(runs);
    expect(best["5k"]).toBe(1400);
    expect(best["10k"]).toBe(3070);
    expect(best.hm).toBeUndefined();
    expect(FASTER_OPTIONS.map(o => o.key)).toEqual(["5k", "10k", "hm"]);
  });
});
