import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import RunningCoach from "./RunningCoach";
import { STORAGE_KEYS } from "./constants";
import type { Participation, Plan, RacesState, Run, SettingsState } from "./types";

let store: Record<string, unknown> = {};

vi.mock("./db", () => ({
  db: {
    get: async (k: string) => store[k] ?? null,
    set: (k: string, v: unknown) => { store[k] = v; },
  },
  currentUserId: () => "test-user",
  flushNow: async () => {},
  isStoreLoaded: () => true,
  isStoreReconciled: () => true,
  isCached: () => true,
}));

vi.mock("./races", () => ({
  listRaces: async () => [],
  addRace: vi.fn(),
  addEdition: vi.fn(),
  reportRace: vi.fn(),
}));

// The race was yesterday; the fixture dates are fixed against this pinned clock.
const TODAY = "2026-10-12";
const RACE_DATE = "2026-10-11";
const ED = "city-10k-2026";

const settings = (over: Record<string, unknown> = {}) => ({
  name: "Ada", onboarded: true, raceDate: RACE_DATE, distanceKm: 10, goalSec: 3000, targetEditionId: ED, ...over,
});

const plan = (raceExtra: Record<string, unknown> = {}) => ({
  raceDate: RACE_DATE, distanceKm: 10, goalSec: 3000,
  weeks: [{ weekNumber: 1, startDate: "2026-10-05", phase: "RACE", sessions: [
    { id: "w1d2", date: "2026-10-07", type: "EASY", km: 5, pace: 360, desc: "Easy run", done: false },
    { id: "race", date: RACE_DATE, type: "RACE", km: 10, pace: 300, desc: "Race Day", editionId: ED, done: false, ...raceExtra },
  ] }],
});

const races = (extra: Partial<Participation> = {}): RacesState => ({
  participations: [{ editionId: ED, label: "City 10K 2026", raceDate: RACE_DATE, distanceKm: 10, status: "wishlist", timeSec: null, runId: null, notes: "", ...extra }],
  seenBadges: [],
});

const raceRun = { id: "r1", date: RACE_DATE, type: "EASY", km: 10, durationSec: 2900 } as Run;

const stored = () => ({
  plan: store[STORAGE_KEYS.PLAN] as Plan,
  races: store[STORAGE_KEYS.RACES] as RacesState,
  settings: store[STORAGE_KEYS.SETTINGS] as SettingsState,
});
const raceSession = () => stored().plan.weeks[0].sessions.find(s => s.id === "race")!;

describe("RunningCoach · settling the race from the debrief", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(TODAY + "T10:00:00"));
    store = {
      [STORAGE_KEYS.SETTINGS]: settings(), [STORAGE_KEYS.PLAN]: plan(),
      [STORAGE_KEYS.RACES]: races(), [STORAGE_KEYS.RUNS]: [],
    };
  });
  afterEach(() => { vi.useRealTimers(); });

  it("doesn't call the missed run-up or the race itself still open", async () => {
    render(<RunningCoach onSignOut={() => {}} />);
    await screen.findByText("How did City 10K 2026 go?");
    expect(screen.queryByText(/still open/)).toBeNull();
  });

  it("'Didn't run it' skips the session and the participation, and Undo puts both back", async () => {
    render(<RunningCoach onSignOut={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Didn't run it" }));
    expect(raceSession().skipped).toBe(true);
    expect(stored().races.participations[0].status).toBe("skipped");
    expect(await screen.findByRole("button", { name: /Set your next goal/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(raceSession().skipped).toBe(false);
    expect(stored().races.participations[0].status).toBe("wishlist");
    expect(await screen.findByText("How did City 10K 2026 go?")).toBeInTheDocument();
  });

  it("naming the run ticks the RACE session and records the result", async () => {
    store[STORAGE_KEYS.RUNS] = [raceRun];
    render(<RunningCoach onSignOut={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "That was my race" }));
    fireEvent.click(screen.getByRole("button", { name: "Count it" }));
    expect(raceSession()).toMatchObject({ done: true, runId: "r1" });
    expect(stored().races.participations[0]).toMatchObject({ status: "done", runId: "r1", timeSec: 2900 });
    // The result, then the effort question, replaces the question.
    expect(await screen.findByText(/48:20, inside your 50:00 goal/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hard" }));
    expect((store[STORAGE_KEYS.RUNS] as Run[])[0].effort).toBe(6);
    expect(await screen.findByRole("button", { name: /Set your next goal/ })).toBeInTheDocument();
  });

  it("a hand-entered race is settled by its session alone", async () => {
    store[STORAGE_KEYS.RUNS] = [raceRun];
    store[STORAGE_KEYS.SETTINGS] = settings({ targetEditionId: null });
    store[STORAGE_KEYS.PLAN] = plan({ editionId: null });
    store[STORAGE_KEYS.RACES] = { participations: [], seenBadges: [] };
    render(<RunningCoach onSignOut={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Yes, I ran one" }));
    fireEvent.click(screen.getByRole("button", { name: "Count it" }));
    expect(raceSession()).toMatchObject({ done: true, runId: "r1" });
    expect(stored().races.participations).toEqual([]);
  });

  it("opens the Plan goal editor when the race was moved", async () => {
    render(<RunningCoach onSignOut={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "It was moved" }));
    expect(await screen.findByRole("button", { name: "Preview changes" })).toBeDisabled();
  });
});
