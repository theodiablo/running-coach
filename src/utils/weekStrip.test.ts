import { describe, it, expect } from "vitest";
import { weekStrip } from "./weekStrip";
import type { Plan, Run } from "../types";

// Wednesday: Monday and Tuesday are behind, Thursday is ahead.
const TODAY = new Date("2026-03-11T00:00:00");
const sess = (id: string, date: string, extra: Record<string, unknown> = {}) =>
  ({ id, date, type: "EASY", desc: "Easy", km: 5, pace: 360, ...extra });
const plan = { weeks: [{ weekNumber: 2, startDate: "2026-03-09", phase: "BASE", sessions: [
  sess("mon", "2026-03-09", { done: true }), sess("tue", "2026-03-10"), sess("thu", "2026-03-12"),
  sess("sat", "2026-03-14", { skipped: true }),
] }] } as unknown as Plan;
const runs = [
  { id: "r1", date: "2026-03-09", type: "EASY", km: 5.2, durationSec: 1800 },
  { id: "r2", date: "2026-03-11", type: "OTHER", km: 0, durationSec: 2400 },
  { id: "r0", date: "2026-03-08", type: "EASY", km: 9, durationSec: 3000 },
] as Run[];

describe("weekStrip", () => {
  it("reads Monday to Sunday: done, still open, planned, rest", () => {
    const w = weekStrip(plan, runs, TODAY);
    expect(w.days.map(d => d.state)).toEqual(["done", "open", "done", "planned", "rest", "rest", "rest"]);
    expect(w.days.map(d => d.today)).toEqual([false, false, true, false, false, false, false]);
  });

  it("counts this week's sessions and running km only", () => {
    expect(weekStrip(plan, runs, TODAY)).toMatchObject({ sessions: 4, done: 1, runs: 2, km: 5.2 });
  });

  it("still reads a week with no plan from the runs alone", () => {
    const w = weekStrip(null, runs, TODAY);
    expect(w.sessions).toBe(0);
    expect(w.days.filter(d => d.state === "done")).toHaveLength(2);
  });
});
