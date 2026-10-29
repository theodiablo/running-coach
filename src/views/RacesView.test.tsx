import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { RacesView } from "./RacesView";
import type { Participation, Plan, RacesState, SettingsState } from "../types";

afterEach(cleanup);
vi.mock("../telemetry", () => ({ track: vi.fn() }));

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
    plan: null, catalogue: [],
    saveRaces: vi.fn(), promoteEdition: vi.fn(), setRaceInPlan: vi.fn(), addRuns: vi.fn(),
    showToast: vi.fn(), openRaceForm: vi.fn(), settleRace: vi.fn(),
    ...over,
  };
  render(<RacesView {...(props as unknown as React.ComponentProps<typeof RacesView>)}/>);
  return props;
};

const logTime = (min: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Add your time" }));
  fireEvent.change(screen.getByPlaceholderText("min"), { target: { value: min } });
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
