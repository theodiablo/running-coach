import { describe, it, expect } from "vitest";
import { computeBadges, nextBadge, unlockedIds } from "./badges";

type TestRun = { date: string; km: number; type?: string };
type TestParticipation = { status: string; distanceKm: number; timeSec?: number | null };
type TestBadge = { id: string; unlocked: boolean; progress: number; hint?: string | null };

const compute = computeBadges as unknown as (runs?: TestRun[], participations?: TestParticipation[]) => TestBadge[];
const next = nextBadge as unknown as (badges: TestBadge[]) => TestBadge | null;
const ids = unlockedIds as unknown as (badges: TestBadge[]) => string[];
const get = (badges: TestBadge[], id: string) => badges.find(b => b.id === id)!;

describe("computeBadges", () => {
  it("locks everything for a brand-new user", () => {
    const badges = compute([], []);
    expect(badges.every(b => !b.unlocked)).toBe(true);
    expect(ids(badges)).toEqual([]);
  });

  it("unlocks distance milestones from the single longest run", () => {
    const badges = compute([{ date: "2026-01-05", km: 12 }], []);
    expect(get(badges, "dist-first-5k").unlocked).toBe(true);
    expect(get(badges, "dist-first-10k").unlocked).toBe(true);
    expect(get(badges, "dist-first-half").unlocked).toBe(false);
  });

  // A walk is still on your feet; a bike is not. Its distance must not become a
  // "longest run" or count toward volume (docs/indoor-sessions.md).
  it("leaves cross-training distance out of the running totals", () => {
    const runs = [
      { date: "2026-01-05", km: 120, type: "OTHER", activity: "bike" },
      { date: "2026-01-12", km: 6, type: "EASY" },
    ];
    expect(get(compute(runs), "dist-first-10k").unlocked).toBe(false);
    expect(get(compute(runs), "vol-100").unlocked).toBe(false);
  });

  it("counts WALK runs toward volume (inclusive)", () => {
    const runs = [
      { date: "2026-01-05", km: 60, type: "WALK" },
      { date: "2026-01-12", km: 50, type: "EASY" },
    ];
    expect(get(compute(runs), "vol-100").unlocked).toBe(true);
  });

  it("consistency counts distinct active weeks, not a fragile streak", () => {
    // Two runs in the SAME week → 1 active week (a gap won't reset progress).
    const sameWeek = [{ date: "2026-01-05", km: 5 }, { date: "2026-01-07", km: 5 }];
    expect(get(compute(sameWeek), "weeks-4").progress).toBeCloseTo(0.25, 5);
    const fourWeeks = [
      { date: "2026-01-05", km: 5 }, { date: "2026-01-12", km: 5 },
      { date: "2026-01-19", km: 5 }, { date: "2026-01-26", km: 5 },
    ];
    expect(get(compute(fourWeeks), "weeks-4").unlocked).toBe(true);
  });

  it("unlocks race badges from participations", () => {
    const parts = [
      { status: "done", distanceKm: 10, timeSec: 3000 },
      { status: "wishlist", distanceKm: 21.1 },
    ];
    const badges = compute([], parts);
    expect(get(badges, "race-wishlist").unlocked).toBe(true);
    expect(get(badges, "race-done-1").unlocked).toBe(true);
    expect(get(badges, "race-done-5").unlocked).toBe(false);
  });

  it("gives locked milestones a remaining-amount hint", () => {
    const badges = compute([{ date: "2026-01-05", km: 7 }], []);
    expect(get(badges, "dist-first-10k").hint).toBe("3 km to go");
  });
});

describe("nextBadge", () => {
  it("returns the locked badge closest to completion", () => {
    const runs = [{ date: "2026-01-05", km: 9 }]; // 9/10 km on first-10k
    const nb = next(compute(runs, []));
    expect(nb!.id).toBe("dist-first-10k");
  });
  it("returns null when nothing is locked", () => {
    const allUnlocked = [{ id: "a", unlocked: true, progress: 1 }];
    expect(next(allUnlocked)).toBeNull();
  });
});
