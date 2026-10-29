import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// @ts-expect-error Shared edge-function ESM has no TypeScript declarations yet.
import { raceStatus, raceStatusLine } from "../../supabase/functions/_shared/coach/phase.mjs";
import { buildPlan } from "./plan";
import { buildOpenPlan } from "./openPlan";
import { ymd } from "./format";
import type { Participation, Plan, Run, SettingsState } from "../types";

// The coach's view of where the runner stands after the race. buildPlan anchors
// week 1 on the next Monday, so the clock is pinned and both alignments run.
const ANCHORS: [string, string][] = [
  ["monday anchor", "2026-09-14"],
  ["midweek anchor", "2026-09-16"],
];

const dayAfter = (from: string, days: number) => { const d = new Date(from + "T00:00:00"); d.setDate(d.getDate() + days); return ymd(d); };
const SESSIONS = [{ dayOffset: 2, minutes: 45 }, { dayOffset: 6, minutes: 90 }];

type Status = (input: unknown, today: string, goalSec?: unknown) => Record<string, unknown> | null;
const status = raceStatus as Status;
const line = raceStatusLine as (s: unknown) => string;

describe.each(ANCHORS)("raceStatus (%s)", (_label, anchor) => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(anchor + "T09:00:00")); });
  afterEach(() => vi.useRealTimers());

  const raceDate = dayAfter(anchor, 84);
  const at = (k: number) => dayAfter(raceDate, k);
  const plan = (over: Record<string, unknown> = {}) =>
    ({ ...buildPlan(raceDate, 3000, SESSIONS, 10, 0, { recovery: true }), ...over }) as unknown as Plan;
  const settle = (p: Plan, patch: Record<string, unknown>): Plan => ({
    ...p, weeks: p.weeks.map(w => ({ ...w, sessions: w.sessions.map(s => s.id === "race" ? { ...s, ...patch } : s) })),
  });
  const input = (p: Plan, runs: Run[] = [], participations: Participation[] = []) =>
    ({ plan: p, settings: { raceDate, targetEditionId: null } as unknown as SettingsState, participations, runs });
  const raceRun = (over: Partial<Run> = {}) => ({ id: "r1", date: raceDate, type: "RACE", km: 10, durationSec: 2900, effort: 5, ...over }) as Run;
  const done = () => settle(plan(), { done: true, runId: "r1" });
  const until = (p: Plan) => (p.recovery as { until: string }).until;

  it("is silent while heading for the race, so those contexts stay as they were", () => {
    for (const k of [-60, -8, -3, 0]) {
      expect(status(input(plan()), at(k), 3000)).toBeNull();
      expect(line(status(input(plan()), at(k), 3000))).toBe("");
    }
    expect(line(null)).toBe("");
  });

  it("passed with no result logged yet", () => {
    expect(line(status(input(plan()), at(3), 3000))).toBe(
      `RACE STATUS: passed, no result logged yet (the 10 km race on ${raceDate}); easy running only through ${until(plan())}.\n`);
  });

  it.each([
    [2900, 3000, "1:40 under the 50:00 goal"],
    [3100, 3000, "1:40 over the 50:00 goal"],
    [3000, 3000, "on the 50:00 goal"],
    [2900, "", "no goal time set"],
  ])("a result of %i against a goal of %s reads %s", (resultSec, goal, vs) => {
    const p = done();
    const s = status(input(p, [raceRun({ durationSec: resultSec })]), at(5), goal);
    expect(line(s)).toBe(
      `RACE STATUS: passed (the 10 km race on ${raceDate}), result ${Math.floor(resultSec / 60)}:${String(resultSec % 60).padStart(2, "0")}, ${vs}; easy running only through ${until(p)}; next goal not chosen yet.\n`);
  });

  it("recovery ends and only the open question is left", () => {
    const p = done();
    const s = status(input(p, [raceRun()]), dayAfter(until(p), 1), 3000);
    expect(s).toMatchObject({ phase: "choosing", recoveryUntil: null });
    expect(line(s)).toBe(`RACE STATUS: passed (the 10 km race on ${raceDate}), result 48:20, 1:40 under the 50:00 goal; next goal not chosen yet.\n`);
  });

  it("a skipped race was not run", () => {
    expect(line(status(input(settle(plan(), { skipped: true })), at(2), 3000)))
      .toBe(`RACE STATUS: not run (the 10 km race on ${raceDate} was skipped); next goal not chosen yet.\n`);
  });

  it("a done race with no time says so", () => {
    expect(line(status(input(settle(plan(), { done: true })), at(2), 3000)))
      .toContain("passed, run (the 10 km race on");
  });

  it("a plan opened behind a race says so while its recovery runs, and only then", () => {
    const p = plan({ openedAfter: { race: dayAfter(raceDate, -50), km: 21.1, until: dayAfter(raceDate, -40) } });
    expect(line(status(input(p), at(-60)))).toBe(
      `RACE STATUS: the plan opened after the 21.1 km race on ${dayAfter(raceDate, -50)}; easy running only through ${dayAfter(raceDate, -40)}.\n`);
    expect(status(input(p), at(-39))).toBeNull();
  });

  it("an open plan is silent, unless it opened behind a race still in recovery", () => {
    vi.setSystemTime(new Date(anchor + "T09:00:00"));
    const open = buildOpenPlan({ planSessions: SESSIONS } as unknown as SettingsState, { target: "healthy", distanceKm: 10 }, { runs: [] });
    const today = open.goal!.startDate as string;
    expect(status(input(open), today)).toBeNull();
    const behind = { ...open, openedAfter: { race: dayAfter(today, -3), km: 10, until: dayAfter(today, 9) } } as Plan;
    expect(line(status(input(behind), today))).toBe(
      `RACE STATUS: open plan, no race (started after the 10 km race on ${dayAfter(today, -3)}); easy running only through ${dayAfter(today, 9)}.\n`);
  });

  it("never throws on a malformed plan", () => {
    const bad = { weeks: [{ sessions: [{ type: "RACE" }] }] } as unknown as Plan;
    expect(status(input(bad), at(3))).toBeNull();
  });
});
