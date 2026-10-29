import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { Dashboard } from "./Dashboard";
import { track } from "../telemetry";
import { dismissTop } from "../utils/backDismiss";
import type { Plan, RacesState, Run, SettingsState } from "../types";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

// A 10K run on Wednesday; today is the day after, inside a recovery through the
// following Tuesday. The fixture dates are fixed against this pinned clock.
const NOW = new Date("2026-03-12T09:00:00");
vi.mock("../telemetry", () => ({ track: vi.fn() }));
vi.useFakeTimers({ shouldAdvanceTime: true });
vi.setSystemTime(NOW);

const RACE_DATE = "2026-03-11";

const sess = (id: string, date: string, extra: Record<string, unknown> = {}) =>
  ({ id, date, type: "EASY", desc: "Recovery run", sd: { kind: "recovery" }, km: 3, pace: 400, done: false, runId: null, ...extra });

const planWith = (extra: Record<string, unknown> = {}, raceExtra: Record<string, unknown> = {}) => ({
  raceDate: RACE_DATE,
  ...extra,
  weeks: [{ weekNumber: 1, startDate: "2026-03-09", phase: "RACE", sessions: [
    { id: "race", date: RACE_DATE, type: "RACE", desc: "Race Day 10km", km: 10, pace: 300, editionId: null, done: true, runId: "r1", ...raceExtra },
    sess("w1d3", "2026-03-12"),
  ] }],
} as unknown as Plan);

const WINDOW = { race: RACE_DATE, km: 10, until: "2026-03-17" };
const settings = { raceDate: RACE_DATE, distanceKm: 10, goalSec: 3000, targetEditionId: null } as unknown as SettingsState;
const races: RacesState = { participations: [], seenBadges: null };
const finished = [{ id: "r1", date: RACE_DATE, type: "RACE", km: 10, durationSec: 2900, effort: 6 }] as Run[];

const renderDash = (over: Record<string, unknown> = {}) => {
  const props = {
    runs: finished, plan: planWith({ recovery: WINDOW }), settings, races,
    goTab: vi.fn(), goProgress: vi.fn(), goLog: vi.fn(),
    toggleSess: vi.fn(), skipSess: vi.fn(), linkSess: vi.fn(), unlinkSess: vi.fn(),
    openSettings: vi.fn(), openCoach: vi.fn(), showToast: vi.fn(),
    settleRace: vi.fn(), skipRace: vi.fn(), openPlanGoalEdit: vi.fn(), updateRun: vi.fn(),
    lightenRecovery: vi.fn(),
    ...over,
  };
  render(<Dashboard {...(props as unknown as React.ComponentProps<typeof Dashboard>)} />);
  return props;
};

describe("Dashboard · recovery after the race", () => {
  it("shows the easy days in the race slot and keeps the next session below it", () => {
    renderDash();
    expect(screen.getByText(/Easy days until/)).toBeInTheDocument();
    expect(screen.getByText("5 days to go. Easy running only, no rush back to speed.")).toBeInTheDocument();
    expect(screen.queryByText("days to go")).toBeNull();
    expect(screen.queryByText("Set your next goal")).toBeNull();
    expect(screen.getByText("Today's session")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start run" })).toBeInTheDocument();
  });

  it("says so on the last easy day", () => {
    renderDash({ plan: planWith({ recovery: { ...WINDOW, until: "2026-03-12" } }) });
    expect(screen.getByText("Last easy day. Back to normal after this.")).toBeInTheDocument();
  });

  it("goes back to choosing the day after `until`, with no sore row", () => {
    renderDash({ plan: planWith({ recovery: { ...WINDOW, until: "2026-03-11" } }) });
    expect(screen.getByRole("button", { name: /Set your next goal/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sore or injured?" })).toBeNull();
  });

  it("a plan written before recovery existed has no card and no row", () => {
    renderDash({ plan: planWith() });
    expect(screen.queryByText(/Easy days until/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Sore or injured?" })).toBeNull();
  });

  it("offers the sore row while the debrief is still asking", () => {
    renderDash({ plan: planWith({ recovery: WINDOW }, { done: false, runId: null }), runs: [] });
    expect(screen.getByText(/Your plan ended on .*Did you run a race\?/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sore or injured?" })).toBeInTheDocument();
  });

  describe("Sore or injured?", () => {
    const open = (over: Record<string, unknown> = {}) => {
      const props = renderDash(over);
      fireEvent.click(screen.getByRole("button", { name: "Sore or injured?" }));
      return props;
    };

    it("lightens what's left", () => {
      const props = open();
      fireEvent.click(screen.getByRole("button", { name: /Make the rest lighter/ }));
      expect(props.lightenRecovery).toHaveBeenCalledTimes(1);
      expect(track).not.toHaveBeenCalledWith("recovery_sore", expect.anything()); // soreness is health data
      expect(screen.queryByText("Recovery is meant to feel easy. If something hurts, take the load off.")).toBeNull();
    });

    it("talks to the coach", () => {
      const props = open();
      fireEvent.click(screen.getByRole("button", { name: /Talk to the coach/ }));
      expect(props.openCoach).toHaveBeenCalledWith(null, "recovery");
      expect(track).not.toHaveBeenCalledWith("recovery_sore", expect.anything());
    });

    it("carries the caveat about sharp or lasting pain, and closes on back", () => {
      open();
      expect(screen.getByText("Sharp or lasting pain: see a professional.")).toBeInTheDocument();
      act(() => { expect(dismissTop()).toBe(true); });
      expect(screen.queryByText("Sharp or lasting pain: see a professional.")).toBeNull();
    });
  });
});
