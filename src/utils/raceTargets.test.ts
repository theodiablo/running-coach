import { describe, it, expect } from "vitest";
import { raceTargets, goalGap, daysBetween, MAX_RACE_TARGETS } from "./raceTargets";
import type { Participation, SettingsState } from "../types";

const TODAY = "2026-09-21";
const race = (editionId: string, raceDate: string, distanceKm: number, extra: Partial<Participation> = {}): Participation =>
  ({ editionId, raceDate, distanceKm, status: "wishlist", label: editionId, ...extra });
const settings = (over: Partial<SettingsState> = {}) =>
  ({ targetEditionId: null, raceDate: "", distanceKm: "", raceElevation: 0, ...over }) as unknown as SettingsState;

describe("daysBetween", () => {
  it("counts whole days, and a race today is zero", () => {
    expect(daysBetween(TODAY, TODAY)).toBe(0);
    expect(daysBetween(TODAY, "2026-09-29")).toBe(8);
  });

  it("survives a DST change rather than rounding to 29.96 days", () => {
    // Europe/Madrid falls back on 25 Oct 2026; the month is 30 days, not 29.96.
    expect(daysBetween("2026-10-11", "2026-11-10")).toBe(30);
  });
});

describe("raceTargets", () => {
  const upcoming = [
    race("behobia", "2026-11-08", 20),
    race("playas", "2026-10-11", 10),
    race("lasarte", "2026-09-26", 14.5),
  ];

  it("orders upcoming races soonest first", () => {
    expect(raceTargets(upcoming, settings(), TODAY).map(r => r.date))
      .toEqual(["2026-09-26", "2026-10-11", "2026-11-08"]);
  });

  it("drops races that have been run, skipped, or have already happened", () => {
    const mixed = [
      ...upcoming,
      race("past", "2026-09-01", 10),
      race("ran", "2026-12-01", 10, { status: "done" }),
      race("bailed", "2026-12-02", 10, { status: "skipped" }),
      race("noDistance", "2026-12-03", 0),
    ];
    expect(raceTargets(mixed, settings(), TODAY).map(r => r.key.split(":")[0]))
      .toEqual(["lasarte", "playas", "behobia"]);
  });

  it("keeps a race happening today", () => {
    const r = raceTargets([race("today", TODAY, 10)], settings(), TODAY);
    expect(r).toHaveLength(1);
    expect(r[0].daysAway).toBe(0);
  });

  it("marks the plan's target race", () => {
    const r = raceTargets(upcoming, settings({ targetEditionId: "behobia" }), TODAY);
    expect(r.filter(x => x.isGoal).map(x => x.key.split(":")[0])).toEqual(["behobia"]);
  });

  // A main race typed into Plan setup has no catalogue edition to point at, so
  // date + distance is the only handle on it.
  it("marks a hand-entered target race by its date and distance", () => {
    const r = raceTargets(upcoming, settings({ raceDate: "2026-11-08", distanceKm: 20 }), TODAY);
    expect(r.find(x => x.isGoal)?.distanceKm).toBe(20);
  });

  // Same day, different distance: a 10 km on the target's date is a different
  // race, so it stays unmarked and the plan's own 20 km gets its own card.
  it("does not mark a race that merely shares the target's date", () => {
    const r = raceTargets([race("other", "2026-11-08", 10)], settings({ raceDate: "2026-11-08", distanceKm: 20 }), TODAY);
    expect(r.find(x => x.key.startsWith("other"))?.isGoal).toBe(false);
    expect(r.filter(x => x.isGoal)).toEqual([expect.objectContaining({ key: "plan:2026-11-08", distanceKm: 20 })]);
  });

  it("gives a plan race that was never added to Races a card of its own", () => {
    const r = raceTargets([], settings({ raceDate: "2026-11-08", distanceKm: 20, raceElevation: 200 }), TODAY);
    expect(r).toEqual([expect.objectContaining({
      date: "2026-11-08", distanceKm: 20, elevation: 200, elevationKnown: true, isGoal: true, label: "",
    })]);
  });

  it("does not duplicate the plan race when it is already listed", () => {
    const r = raceTargets(upcoming, settings({ targetEditionId: "behobia", raceDate: "2026-11-08", distanceKm: 20 }), TODAY);
    expect(r).toHaveLength(3);
  });

  it("leaves a plan race that has already been run out", () => {
    expect(raceTargets([], settings({ raceDate: "2026-09-01", distanceKm: 20 }), TODAY)).toEqual([]);
  });

  describe("elevation", () => {
    const elev = (id?: string | null) => (id === "behobia" ? 200 : id === "playas" ? 0 : null);

    it("takes the catalogue's climb, and tells flat apart from unknown", () => {
      const byKey = Object.fromEntries(raceTargets(upcoming, settings(), TODAY, elev).map(r => [r.key.split(":")[0], r]));
      expect(byKey.behobia).toMatchObject({ elevation: 200, elevationKnown: true });
      expect(byKey.playas).toMatchObject({ elevation: 0, elevationKnown: true });   // known to be flat
      expect(byKey.lasarte).toMatchObject({ elevation: 0, elevationKnown: false }); // a trail race, climb unknown
    });

    it("prefers the runner's own raceElevation over the catalogue", () => {
      const r = raceTargets(upcoming, settings({ targetEditionId: "behobia", raceElevation: 350 }), TODAY, elev);
      expect(r.find(x => x.isGoal)?.elevation).toBe(350);
    });
  });

  describe("the cap", () => {
    const many = Array.from({length: 6}, (_, i) => race("r" + i, "2026-10-0" + (i + 1), 10));

    it("shows only the nearest few", () => {
      expect(raceTargets(many, settings(), TODAY)).toHaveLength(MAX_RACE_TARGETS);
    });

    // The A race a block builds to is usually the furthest out, so a plain
    // slice is exactly what would drop it.
    it("keeps the goal race even when it falls past the cap", () => {
      const r = raceTargets(many, settings({ targetEditionId: "r5" }), TODAY);
      expect(r).toHaveLength(MAX_RACE_TARGETS);
      expect(r[r.length - 1].key.split(":")[0]).toBe("r5");
      expect(r[0].key.split(":")[0]).toBe("r0");
    });
  });

  it("copes with no races at all", () => {
    expect(raceTargets(null, settings(), TODAY)).toEqual([]);
    expect(raceTargets(undefined, settings(), TODAY)).toEqual([]);
  });
});

describe("goalGap", () => {
  const goalTarget = { key: "g", label: "", date: "2026-11-08", distanceKm: 20, elevation: 200, elevationKnown: true, daysAway: 48, isGoal: true };

  it("reports a projection slower than the goal as over", () => {
    expect(goalGap(settings({ goalSec: 6300, distanceKm: 20 }), goalTarget, 6361))
      .toEqual({ goalSec: 6300, diffSec: 61, over: true });
  });

  it("reports a projection faster than the goal as under", () => {
    expect(goalGap(settings({ goalSec: 6300, distanceKm: 20 }), goalTarget, 6100))
      .toMatchObject({ diffSec: -200, over: false });
  });

  it("stays silent on a race that isn't the goal", () => {
    expect(goalGap(settings({ goalSec: 6300, distanceKm: 20 }), { ...goalTarget, isGoal: false }, 6361)).toBeNull();
  });

  // The goal time belongs to the distance the plan was built for; offering it
  // against a tune-up of another length compares two different things.
  it("stays silent when the goal was set for another distance", () => {
    expect(goalGap(settings({ goalSec: 6300, distanceKm: 20 }), { ...goalTarget, distanceKm: 10 }, 2800)).toBeNull();
  });

  it("stays silent with no goal time set", () => {
    expect(goalGap(settings({ distanceKm: 20 }), goalTarget, 6361)).toBeNull();
  });
});
