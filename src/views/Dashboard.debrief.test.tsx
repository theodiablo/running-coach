import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Dashboard } from "./Dashboard";
import { track } from "../telemetry";
import type { Participation, Plan, RacesState, Run, SettingsState } from "../types";

afterEach(cleanup);

// The race is "yesterday" unless a case moves it; nothing here builds a plan,
// so the fixture dates are fixed against this pinned clock.
const NOW = new Date("2026-03-12T09:00:00");
vi.mock("../telemetry", () => ({ track: vi.fn() }));
vi.useFakeTimers({ shouldAdvanceTime: true });
vi.setSystemTime(NOW);

const RACE_DATE = "2026-03-11";
const FUTURE_RACE = "2026-04-20";

const raceSess = (date: string, extra: Record<string, unknown> = {}) =>
  ({ id: "race", date, type: "RACE", desc: "Race Day 10km", km: 10, pace: 300, editionId: null, ...extra });

const planOf = (sessions: Record<string, unknown>[]) =>
  ({ raceDate: String(sessions[0].date), weeks: [{ weekNumber: 1, startDate: "2026-03-09", phase: "RACE", sessions }] } as unknown as Plan);

const settingsOf = (raceDate: string, extra: Record<string, unknown> = {}) =>
  ({ raceDate, distanceKm: 10, goalSec: 3000, targetEditionId: null, ...extra }) as unknown as SettingsState;

const part = (extra: Partial<Participation> = {}): Participation =>
  ({ editionId: "ed-1", label: "City 10K 2026", raceDate: RACE_DATE, distanceKm: 10, status: "wishlist", timeSec: null, runId: null, notes: "", ...extra });

const racesOf = (participations: Participation[] = []): RacesState => ({ participations, seenBadges: null });

const raceRun = (extra: Partial<Run> = {}) =>
  ({ id: "r1", date: RACE_DATE, type: "EASY", km: 10, durationSec: 2900, ...extra }) as Run;

const renderDash = (over: Record<string, unknown> = {}) => {
  const props = {
    runs: [], plan: planOf([raceSess(RACE_DATE)]), settings: settingsOf(RACE_DATE), races: racesOf(),
    goTab: vi.fn(), goProgress: vi.fn(), goLog: vi.fn(),
    toggleSess: vi.fn(), skipSess: vi.fn(), linkSess: vi.fn(), unlinkSess: vi.fn(),
    openSettings: vi.fn(), openCoach: vi.fn(), showToast: vi.fn(),
    settleRace: vi.fn(), skipRace: vi.fn(), openPlanGoalEdit: vi.fn(), updateRun: vi.fn(),
    ...over,
  };
  render(<Dashboard {...(props as unknown as React.ComponentProps<typeof Dashboard>)} />);
  return props;
};

describe("Dashboard · before the race", () => {
  it("never prints a 0:00 target when the runner set no goal", () => {
    renderDash({ plan: planOf([raceSess(FUTURE_RACE)]), settings: settingsOf(FUTURE_RACE, { goalSec: "" }) });
    expect(screen.getByText("10km · no time goal set")).toBeInTheDocument();
    expect(screen.queryByText(/sub /)).toBeNull();
    expect(screen.queryByText(/0:00/)).toBeNull();
  });

  it("keeps the countdown card and the coach card", () => {
    renderDash({ plan: planOf([raceSess(FUTURE_RACE)]), settings: settingsOf(FUTURE_RACE) });
    expect(screen.getByText("days to go")).toBeInTheDocument();
    expect(screen.getByText("Adjust your plan with your coach")).toBeInTheDocument();
  });
});

describe("Dashboard · the debrief question", () => {
  const catalogue = () => renderDash({
    plan: planOf([raceSess(RACE_DATE, { editionId: "ed-1" })]),
    settings: settingsOf(RACE_DATE, { targetEditionId: "ed-1" }), races: racesOf([part()]),
  });

  it("asks how the named race went, and drops the countdown, the all-done line and the coach card", () => {
    catalogue();
    expect(screen.getByText("How did City 10K 2026 go?")).toBeInTheDocument();
    expect(screen.queryByText("days to go")).toBeNull();
    expect(screen.queryByText("All upcoming sessions done!")).toBeNull();
    expect(screen.queryByText("Adjust your plan with your coach")).toBeNull();
  });

  it("asks a plainer question for a race the catalogue doesn't know", () => {
    renderDash();
    expect(screen.getByText(/Your plan ended on .*Did you run a race\?/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "It was moved" })).toBeNull();
  });

  it("'Didn't run it' skips the race", () => {
    const props = catalogue();
    fireEvent.click(screen.getByRole("button", { name: "Didn't run it" }));
    expect(props.skipRace).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("debrief_answered", { answer: "didnt" });
  });

  it("a neutral 'No' skips it too", () => {
    const props = renderDash();
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(props.skipRace).toHaveBeenCalledTimes(1);
  });

  it("'It was moved' opens the Plan goal editor", () => {
    const props = catalogue();
    fireEvent.click(screen.getByRole("button", { name: "It was moved" }));
    expect(props.openPlanGoalEdit).toHaveBeenCalledTimes(1);
  });

  it("'That was my race' with no run to name goes to the log, prefilled from the race", () => {
    const props = catalogue();
    fireEvent.click(screen.getByRole("button", { name: "That was my race" }));
    expect(props.goLog).toHaveBeenCalledWith(expect.objectContaining({ date: RACE_DATE, type: "RACE", km: 10 }));
    expect(props.settleRace).not.toHaveBeenCalled();
  });

  it("'That was my race' with a run on the day lets the runner name it", () => {
    const props = renderDash({
      plan: planOf([raceSess(RACE_DATE, { editionId: "ed-1" })]),
      settings: settingsOf(RACE_DATE, { targetEditionId: "ed-1" }), races: racesOf([part()]), runs: [raceRun()],
    });
    fireEvent.click(screen.getByRole("button", { name: "That was my race" }));
    expect(props.goLog).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Count it" }));
    expect(props.settleRace).toHaveBeenCalledWith("r1", 2900);
  });

  it("a moved catalogue date keeps today's race card instead of asking", () => {
    renderDash({
      plan: planOf([raceSess(RACE_DATE, { editionId: "ed-1" })]),
      settings: settingsOf(RACE_DATE, { targetEditionId: "ed-1" }), races: racesOf([part()]),
      dateChanges: [{ editionId: "ed-1", label: "City 10K 2026", oldDate: RACE_DATE, newDate: FUTURE_RACE, isTarget: true }],
      applyRaceDateChange: vi.fn(), keepRaceDate: vi.fn(),
    });
    expect(screen.queryByText("How did City 10K 2026 go?")).toBeNull();
    expect(screen.getByText("days to go")).toBeInTheDocument();
  });
});

describe("Dashboard · the result", () => {
  const settled = (over: Record<string, unknown> = {}) => renderDash({
    plan: planOf([raceSess(RACE_DATE, { done: true, runId: "r1" })]), runs: [raceRun()], ...over,
  });

  it("praises a time inside the goal", () => {
    settled({ settings: settingsOf(RACE_DATE, { goalSec: 3000 }) });
    expect(screen.getByText(/48:20, inside your 50:00 goal/)).toHaveClass("text-emerald-300");
  });

  it("is kind about a time over the goal, in amber and never red", () => {
    settled({ settings: settingsOf(RACE_DATE, { goalSec: 2700 }) });
    const line = screen.getByText(/48:20 against your 45:00 goal/);
    expect(line).toHaveClass("text-amber-300");
    expect(line.className).not.toMatch(/red/);
  });

  it("just reports the time when there was no goal", () => {
    settled({ settings: settingsOf(RACE_DATE, { goalSec: "" }) });
    expect(screen.getByText("You finished in 48:20.")).toBeInTheDocument();
  });

  it.each([["Easy", 4], ["Hard", 6], ["Very hard", 8], ["All out", 10]])("'%s' records effort %i on the race run", (name, effort) => {
    const props = settled();
    fireEvent.click(screen.getByRole("button", { name }));
    expect(props.updateRun).toHaveBeenCalledWith("r1", { effort });
  });
});

describe("Dashboard · choosing what's next", () => {
  const choosing = () => renderDash({ plan: planOf([raceSess(RACE_DATE, { skipped: true })]) });

  it("offers the next goal and the race list, with no urgency", () => {
    const props = choosing();
    expect(screen.queryByText("All upcoming sessions done!")).toBeNull();
    expect(screen.queryByText("Adjust your plan with your coach")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Set your next goal/ }));
    expect(props.openPlanGoalEdit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Browse races/ }));
    expect(props.goTab).toHaveBeenCalledWith("races");
  });

  it("a race older than the debrief window also lands here", () => {
    renderDash({ plan: planOf([raceSess("2026-01-20")]), settings: settingsOf("2026-01-20") });
    expect(screen.getByRole("button", { name: /Set your next goal/ })).toBeInTheDocument();
  });
});
