import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import RunningCoach from "./RunningCoach";
import { STORAGE_KEYS } from "./constants";
import type { Participation, Plan, RacesState, SettingsState } from "./types";

let store: Record<string, unknown> = {};

vi.mock("./db", () => ({
  db: {
    get: async (k: string) => store[k] ?? null,
    set: (k: string, v: unknown) => { store[k] = v; },
  },
  currentUserId: () => "test-user",
  flushNow: async () => {},
}));

// The catalogue now lists the Barcelona half a week earlier than the user planned.
vi.mock("./races", () => ({
  listRaces: async () => [{
    id: "barcelona-half-marathon", name: "Mitja Barcelona", verified: true,
    editions: [{ id: "barcelona-half-marathon-2027-02-21", date: "2027-02-14", distanceKm: 21.1 }],
  }],
  addRace: vi.fn(),
  addEdition: vi.fn(),
  reportRace: vi.fn(),
}));

const ED = "barcelona-half-marathon-2027-02-21";
const SETTINGS = {
  name: "Ada", onboarded: true, raceDate: "2027-02-21", distanceKm: 21.1, goalSec: 6300,
  targetEditionId: ED,
};
const PLAN = {
  raceDate: "2027-02-21", distanceKm: 21.1, goalSec: 6300,
  weeks: [{ weekNumber: 1, startDate: "2026-09-28", phase: "BASE", sessions: [] }],
};
const RACES = {
  participations: [{ editionId: ED, raceId: "barcelona-half-marathon", label: "Mitja Barcelona 2027", raceDate: "2027-02-21", distanceKm: 21.1, status: "wishlist" }],
  seenBadges: [],
};

describe("RunningCoach race date changes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00"));
    store = { [STORAGE_KEYS.SETTINGS]: SETTINGS, [STORAGE_KEYS.PLAN]: PLAN, [STORAGE_KEYS.RACES]: RACES };
  });
  afterEach(() => { vi.useRealTimers(); });

  it("moves the target race, its list entry and the plan to the new date", async () => {
    render(<RunningCoach onSignOut={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Update my plan" }));

    expect((store[STORAGE_KEYS.SETTINGS] as SettingsState).raceDate).toBe("2027-02-14");
    const part = (store[STORAGE_KEYS.RACES] as RacesState).participations[0] as Participation;
    expect(part.raceDate).toBe("2027-02-14");
    const plan = store[STORAGE_KEYS.PLAN] as Plan;
    const race = plan.weeks.flatMap(w => w.sessions).find(s => s.type === "RACE");
    expect(race?.date).toBe("2027-02-14");
    expect(screen.queryByRole("button", { name: "Update my plan" })).not.toBeInTheDocument();
  });

  it("keeps the user's date and stops asking", async () => {
    render(<RunningCoach onSignOut={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Keep my date" }));

    expect((store[STORAGE_KEYS.SETTINGS] as SettingsState).raceDate).toBe("2027-02-21");
    expect((store[STORAGE_KEYS.RACES] as RacesState).dateAcks).toEqual({ [ED]: "2027-02-14" });
    expect(screen.queryByRole("button", { name: "Keep my date" })).not.toBeInTheDocument();
  });
});
