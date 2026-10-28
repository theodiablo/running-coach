import { describe, it, expect, beforeAll } from "vitest";
import { detectRaceCompletion } from "./raceCompletion";
import { hydrateCatalogue } from "./races";
import type { Participation, Plan, PlanSession, RacesState, Run, SettingsState } from "../types";

const RACE_DAY = "2026-10-11";
const TUNE_UP = "2026-09-20";
const NEUTRAL = "your race";

beforeAll(() => {
  hydrateCatalogue([{
    id: "city-10k", slug: "city-10k", name: "City 10K", city: "Lyon", country: "FR", lat: 45.7, lng: 4.8, distances: [10], verified: true,
    editions: [{ id: "city-10k-2026", date: RACE_DAY, distanceKm: 10, elevation: 20, verified: true }],
  }]);
});

const raceSess = (id: string, date: string, extra: Partial<PlanSession> = {}): PlanSession =>
  ({ id, date, type: "RACE", desc: "Race Day", km: 10, pace: 300, done: false, runId: null, editionId: null, ...extra });

const planOf = (sessions: PlanSession[]) =>
  ({ raceDate: RACE_DAY, weeks: [{ weekNumber: 4, startDate: "2026-10-05", phase: "RACE", sessions }] } as unknown as Plan);

const settings = (extra: Record<string, unknown> = {}) =>
  ({ raceDate: RACE_DAY, distanceKm: 10, goalSec: 3000, targetEditionId: null, ...extra }) as unknown as SettingsState;

const races = (participations: Participation[] = []): RacesState => ({ participations, seenBadges: null });

const wish = (extra: Partial<Participation> = {}): Participation =>
  ({ editionId: "city-10k-2026", label: "City 10K 2026", raceDate: RACE_DAY, distanceKm: 10, status: "wishlist", timeSec: null, runId: null, notes: "", ...extra });

const ran = (extra: Partial<Run> = {}): Run => ({ id: "r1", date: RACE_DAY, type: "EASY", km: 10, durationSec: 2900, ...extra } as Run);

const detect = (over: Record<string, unknown> = {}) => detectRaceCompletion({
  added: [ran()], plan: planOf([raceSess("race", RACE_DAY)]), settings: settings(), races: races(), yourRaceLabel: NEUTRAL, ...over,
} as Parameters<typeof detectRaceCompletion>[0]);

describe("detectRaceCompletion", () => {
  it("ticks a hand-entered race's session and writes no participation", () => {
    const out = detect();
    expect(out?.link).toEqual({ wNum: 4, sId: "race", runId: "r1" });
    expect(out?.label).toBe(NEUTRAL);
    expect(out?.nextRaces.participations).toEqual([]);
    expect(out?.isMain).toBe(false); // no confetti for a race the catalogue doesn't know
  });

  it("does both for a catalogue race stamped on the session", () => {
    const out = detect({ plan: planOf([raceSess("race", RACE_DAY, { editionId: "city-10k-2026" })]),
      settings: settings({ targetEditionId: "city-10k-2026" }), races: races([wish()]) });
    expect(out?.link).toEqual({ wNum: 4, sId: "race", runId: "r1" });
    expect(out?.nextRaces.participations[0]).toMatchObject({ status: "done", runId: "r1", timeSec: 2900, source: "auto" });
    expect(out?.undoParts[0].status).toBe("wishlist");
    expect(out?.label).toBe("City 10K 2026");
    expect(out?.isMain).toBe(true);
  });

  it("finds the edition through settings.targetEditionId when the session was built without it", () => {
    const out = detect({ settings: settings({ targetEditionId: "city-10k-2026" }) });
    expect(out?.nextRaces.participations).toHaveLength(1);
    expect(out?.nextRaces.participations[0]).toMatchObject({ editionId: "city-10k-2026", status: "done" });
    expect(out?.label).toBe("City 10K 2026");
    expect(out?.link?.sId).toBe("race");
  });

  it("marks nothing twice", () => {
    const done = planOf([raceSess("race", RACE_DAY, { editionId: "city-10k-2026", done: true, runId: "r0" })]);
    expect(detect({ plan: done, races: races([wish({ status: "done" })]) })).toBeNull();
    // A hand-entered race already ticked has nothing left to settle either.
    expect(detect({ plan: planOf([raceSess("race", RACE_DAY, { done: true, runId: "r0" })]) })).toBeNull();
  });

  it("settles only the session when the participation was already done", () => {
    const out = detect({ plan: planOf([raceSess("race", RACE_DAY, { editionId: "city-10k-2026" })]), races: races([wish({ status: "done" })]) });
    expect(out?.link).not.toBeNull();
    expect(out?.isMain).toBe(false);
  });

  it("settles only the participation when the session was already ticked", () => {
    const out = detect({ plan: planOf([raceSess("race", RACE_DAY, { editionId: "city-10k-2026", done: true, runId: "r0" })]), races: races([wish()]) });
    expect(out?.link).toBeNull();
    expect(out?.nextRaces.participations[0].status).toBe("done");
  });

  it("needs the right day and a near distance", () => {
    expect(detect({ added: [ran({ date: "2026-10-10" })] })).toBeNull();
    expect(detect({ added: [ran({ km: 5 })] })).toBeNull();
  });

  it("ticks a secondary race's own session", () => {
    const plan = planOf([raceSess("race-tune", TUNE_UP, { editionId: "tune-ed" }), raceSess("race", RACE_DAY)]);
    const out = detect({ plan, added: [ran({ date: TUNE_UP })], races: races([wish({ editionId: "tune-ed", raceDate: TUNE_UP })]) });
    expect(out?.link).toEqual({ wNum: 4, sId: "race-tune", runId: "r1" });
    expect(out?.nextRaces.participations[0].editionId).toBe("tune-ed");
  });

  it("recognises a carried past race but has no session to tick", () => {
    const plan = planOf([raceSess("past-race", RACE_DAY, { editionId: "city-10k-2026" })]);
    const out = detect({ plan, settings: settings({ raceDate: "2027-01-01" }), races: races([wish()]) });
    expect(out?.link).toBeNull();
    expect(out?.nextRaces.participations[0].status).toBe("done");
  });

  describe("race-day mode (no plan, the wishlist is the race list)", () => {
    const raceDaySettings = settings({ liveFirst: true, raceDate: "", distanceKm: "" });

    it("matches the wishlist race and ticks no session", () => {
      const out = detect({ plan: null, settings: raceDaySettings, races: races([wish()]) });
      expect(out).toMatchObject({ raceDay: true, isMain: true, link: null, label: "City 10K 2026" });
      expect(out?.nextRaces.participations[0]).toMatchObject({ status: "done", runId: "r1" });
    });

    it("leaves an already-done race alone", () => {
      expect(detect({ plan: null, settings: raceDaySettings, races: races([wish({ status: "done" })]) })).toBeNull();
    });
  });
});
