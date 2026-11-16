import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { RacesView } from "./RacesView";
import { searchRaces } from "../races";
import type { CatalogueRace } from "../types";
import type { Participation, Plan, RacesState, SettingsState } from "../types";

afterEach(cleanup);
vi.mock("../telemetry", () => ({ track: vi.fn() }));
vi.mock("../races", () => ({
  reportRace: vi.fn().mockResolvedValue(undefined),
  listRaceCountries: vi.fn().mockResolvedValue([{ country: "ES", races: 3 }, { country: "FR", races: 2 }]),
  peekRaceSearch: vi.fn(() => null),
  raceSearchVersion: () => 0,
  searchRaces: vi.fn(),
}));
vi.mock("../components/races/RaceMiniMap", () => ({ RaceMiniMap: () => null }));

const NOW = new Date("2026-03-12T09:00:00");
vi.useFakeTimers({ shouldAdvanceTime: true });
vi.setSystemTime(NOW);

const PAST = "2026-03-01";

const part = (extra: Partial<Participation> = {}): Participation =>
  ({ editionId: "ed-1", label: "City 10K 2026", raceDate: PAST, distanceKm: 10, status: "wishlist", timeSec: null, runId: null, notes: "", ...extra });

const planWithRace = (editionId: string | null) => ({
  raceDate: PAST,
  weeks: [{ weekNumber: 1, startDate: "2026-02-23", phase: "RACE", sessions: [
    { id: "race", date: PAST, type: "RACE", km: 10, pace: 300, desc: "Race Day", editionId },
  ] }],
}) as unknown as Plan;

const renderRaces = (participations: Participation[], over: Record<string, unknown> = {}) => {
  const props = {
    races: { participations, seenBadges: null } as RacesState,
    settings: { raceDate: PAST, distanceKm: 10, targetEditionId: null } as unknown as SettingsState,
    plan: null, runs: [],
    saveRaces: vi.fn(), promoteEdition: vi.fn(), setRaceInPlan: vi.fn(), addRuns: vi.fn(),
    showToast: vi.fn(), openRaceForm: vi.fn(), settleRace: vi.fn(),
    ...over,
  };
  render(<RacesView {...(props as unknown as React.ComponentProps<typeof RacesView>)}/>);
  return props;
};

const logTime = (min: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Add your time" }));
  fireEvent.change(screen.getByPlaceholderText("h:mm:ss"), { target: { value: min + "00" } });
  fireEvent.click(screen.getByRole("button", { name: "Save result" }));
};

describe("RacesView · results", () => {
  it("lists a 'didn't run' answer with the past races, still open to a time", () => {
    renderRaces([part({ status: "skipped" })]);
    expect(screen.getByText("Didn't run")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add your time" })).toBeInTheDocument();
  });

  it("logs the race run without inventing an effort", () => {
    const props = renderRaces([part()]);
    logTime("50");
    const [runs, opts] = props.addRuns.mock.calls[0];
    expect(runs[0]).toMatchObject({ type: "RACE", km: 10, durationSec: 3000, effort: null });
    expect(opts).toEqual({ skipDetect: true });
  });

  it("writes an ordinary race's participation itself", () => {
    const props = renderRaces([part()]);
    logTime("50");
    expect(props.settleRace).not.toHaveBeenCalled();
    expect(props.saveRaces.mock.calls[0][0].participations[0]).toMatchObject({ status: "done", timeSec: 3000 });
  });

  it("hands the plan's main race to the hub, which ticks its RACE session as well", () => {
    const props = renderRaces([part()], { plan: planWithRace("ed-1") });
    logTime("50");
    const runId = props.addRuns.mock.calls[0][0][0].id;
    expect(props.settleRace).toHaveBeenCalledWith(runId, 3000, { notes: expect.any(String), quiet: true });
    expect(props.saveRaces).not.toHaveBeenCalled();
  });

  it("answers 'didn't run' with a time too", () => {
    const props = renderRaces([part({ status: "skipped" })], { plan: planWithRace("ed-1") });
    logTime("55");
    expect(props.settleRace).toHaveBeenCalledWith(expect.any(String), 3300, expect.anything());
  });
});

describe("RacesView · a plan with no race", () => {
  const FUTURE = "2026-04-02";
  const openPlan = (): Plan => ({
    raceDate: "", goal: { kind: "open", target: "healthy" },
    weeks: [{ weekNumber: 1, startDate: "2026-03-09", phase: "BASE", sessions: [] }, { weekNumber: 2, startDate: "2026-03-16", phase: "BASE", sessions: [] },
      { weekNumber: 3, startDate: "2026-03-23", phase: "BASE", sessions: [] }, { weekNumber: 4, startDate: "2026-03-30", phase: "BASE", sessions: [] }],
  }) as unknown as Plan;
  const upcoming = (raceDate: string) => part({ raceDate, editionId: "ed-2", label: "Park 10K 2026" });

  it("offers to add a race that falls inside the plan's weeks", () => {
    renderRaces([upcoming(FUTURE)], { plan: openPlan(), settings: { raceDate: "", distanceKm: 10 } as unknown as SettingsState });
    expect(screen.getByRole("button", { name: "Add to plan" })).toBeInTheDocument();
  });

  it("not one that falls after them", () => {
    renderRaces([upcoming("2026-04-20")], { plan: openPlan(), settings: { raceDate: "", distanceKm: 10 } as unknown as SettingsState });
    expect(screen.queryByRole("button", { name: "Add to plan" })).toBeNull();
  });
});

const FUTURE = "2026-06-14";
const upcoming = (extra: Partial<Participation> = {}) => part({ raceDate: FUTURE, editionId: "ed-2", label: "Spring Half 2026", distanceKm: 21.1, ...extra });

describe("RacesView · race page", () => {
  it("opens a listed race and saves a goal typed for it", () => {
    const props = renderRaces([upcoming()]);
    fireEvent.click(screen.getByRole("button", { name: /Spring Half 2026/ }));
    const goal = screen.getByRole("textbox", { name: "Your goal" });
    fireEvent.change(goal, { target: { value: "14500" } });
    fireEvent.blur(goal);
    expect(props.saveRaces.mock.calls.at(-1)?.[0].participations[0]).toMatchObject({ editionId: "ed-2", goalSec: 6300 });
    expect(props.showToast).toHaveBeenCalledWith("Goal saved.");
  });

  it("shows what a new target goal does to the plan, and applies it through the hub", () => {
    const before = { racePace: 300, weeks: [{ sessions: [{ id: "e", date: "2026-03-20", type: "EASY", pace: 380 }] }] } as unknown as Plan;
    const after = { racePace: 290, weeks: [{ sessions: [{ id: "e", date: "2026-03-20", type: "EASY", pace: 368 }] }] } as unknown as Plan;
    const previewTargetGoal = vi.fn(() => after);
    const updateTargetGoal = vi.fn();
    renderRaces([upcoming()], {
      plan: before, previewTargetGoal, updateTargetGoal,
      settings: { raceDate: FUTURE, distanceKm: 21.1, goalSec: 6300, targetEditionId: "ed-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Spring Half 2026/ }));
    expect(screen.getByRole("textbox", { name: "Your goal" })).toHaveValue("1:45:00");
    fireEvent.change(screen.getByRole("textbox", { name: "Your goal" }), { target: { value: "14000" } });
    expect(previewTargetGoal).toHaveBeenCalledWith(6000);
    expect(screen.getByText("Your plan's paces change")).toBeInTheDocument();
    expect(screen.getByText("Race pace")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Update plan to 1:40:00" }));
    expect(updateTargetGoal).toHaveBeenCalledWith(6000);
  });

  it("previews nothing while a target goal is still being typed", () => {
    const previewTargetGoal = vi.fn(() => null);
    renderRaces([upcoming()], {
      plan: { weeks: [] }, previewTargetGoal, updateTargetGoal: vi.fn(),
      settings: { raceDate: FUTURE, distanceKm: 21.1, goalSec: 6300, targetEditionId: "ed-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Spring Half 2026/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your goal" }), { target: { value: "130" } });
    expect(previewTargetGoal).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save goal" })).toBeDisabled();
  });

  it("carries a race to Plan setup from its page", () => {
    const props = renderRaces([upcoming()]);
    fireEvent.click(screen.getByRole("button", { name: /Spring Half 2026/ }));
    fireEvent.click(screen.getByRole("button", { name: "Set as training target" }));
    expect(props.promoteEdition).toHaveBeenCalledWith(expect.objectContaining({ edition: expect.objectContaining({ id: "ed-2" }) }));
  });
});

const race = (i: number, extra: Partial<CatalogueRace> = {}): CatalogueRace => ({
  id: "race-" + i, slug: "race-" + i, name: "Race " + i, city: "Valencia", country: "ES", verified: true,
  editions: [{ id: "race-" + i + "-ed", date: "2026-04-" + String(10 + (i % 15)).padStart(2, "0"), distanceKm: 10 }], ...extra,
});

describe("RacesView · find", () => {
  it("pages the server search with Load more and opens a race from the list", async () => {
    localStorage.clear();
    vi.mocked(searchRaces)
      .mockResolvedValueOnce({ races: Array.from({ length: 20 }, (_, i) => race(i)), next: { key: 30, slug: "race-19" }, total: 21 })
      .mockResolvedValueOnce({ races: [race(20, { name: "Last Race" })], next: null, total: null });
    renderRaces([]);
    fireEvent.click(screen.getByRole("button", { name: "Find a race" }));
    expect(await screen.findByText("21 races coming up")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load 1 more" }));
    expect(await screen.findByText("Last Race")).toBeInTheDocument();
    expect(vi.mocked(searchRaces).mock.calls[1][1]).toEqual({ key: 30, slug: "race-19" });
    fireEvent.click(screen.getByText("Last Race"));
    expect(screen.getByRole("dialog", { name: "Last Race" })).toBeInTheDocument();
  });

  it("sends the distance range and terrain to the server, and remembers them on this device", async () => {
    localStorage.clear();
    vi.mocked(searchRaces).mockResolvedValue({ races: [], next: null, total: 0 });
    renderRaces([]);
    fireEvent.click(screen.getByRole("button", { name: "Find a race" }));
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.change(screen.getByRole("slider", { name: "Shortest distance" }), { target: { value: "2" } });
    fireEvent.change(screen.getByRole("slider", { name: "Longest distance" }), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Trail" }));
    await vi.waitFor(() => expect(vi.mocked(searchRaces).mock.calls.at(-1)?.[0]).toMatchObject({ minKm: 10, maxKm: 21.1, terrain: "trail" }));
    expect(JSON.parse(localStorage.getItem("rc_race_filters") || "{}")).toMatchObject({ distance: { min: 2, max: 4 }, terrain: "trail" });
    expect(await screen.findByText("No races match — try a different search.")).toBeInTheDocument();
  });
});

describe("RacesView · countries and the session cache", () => {
  it("filters by several countries at once", async () => {
    localStorage.clear();
    vi.mocked(searchRaces).mockResolvedValue({ races: [], next: null, total: 0 });
    renderRaces([]);
    fireEvent.click(screen.getByRole("button", { name: "Find a race" }));
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(await screen.findByRole("button", { name: /Spain/ }));
    await vi.waitFor(() => expect(vi.mocked(searchRaces).mock.calls.at(-1)?.[0]).toMatchObject({ countries: ["ES"] }));
    expect(screen.getByRole("button", { name: "Remove filter: Spain" })).toBeInTheDocument();
  });
});
