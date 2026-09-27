import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PlanView } from "./PlanView";
import type { Plan, SettingsState, ToastAction } from "../types";

afterEach(cleanup);
vi.mock("../telemetry", () => ({ track: vi.fn() }));

// Sunday: the stubbed rebuild starts on the next Monday, like buildPlan.
const NOW = new Date("2026-09-27T09:00:00");
vi.useFakeTimers({ shouldAdvanceTime: true });
vi.setSystemTime(NOW);

const sess = (id: string, date: string, type: string, km: number, extra: Record<string, unknown> = {}) =>
  ({ id, date, type, km, pace: 365, desc: type + " run", ...extra });

const current = {
  raceDate: "2026-11-08", distanceKm: 20,
  weeks: [
    { weekNumber: 1, startDate: "2026-09-21", phase: "BASE", sessions: [sess("w1d6", "2026-09-26", "LONG", 7, { done: true })] },
    { weekNumber: 2, startDate: "2026-09-28", phase: "BASE", sessions: [sess("w2d3", "2026-10-01", "TEMPO", 6.3), sess("w2d6", "2026-10-04", "LONG", 14.5)] },
  ],
} as unknown as Plan;

const rebuilt = {
  raceDate: "2026-11-08", distanceKm: 20,
  weeks: [
    { weekNumber: 1, startDate: "2026-09-28", phase: "BASE", sessions: [sess("w1d3", "2026-10-01", "EASY", 5.9), sess("w1d6", "2026-10-04", "LONG", 14.5)] },
  ],
} as unknown as Plan;

const settings = {
  raceDate: "2026-11-08", distanceKm: 20, goalSec: 6300, raceElevation: 0, planStyle: "balanced",
  availabilityMode: "custom", planSessions: [{ dayOffset: 3, minutes: 45 }, { dayOffset: 6, minutes: 75 }], maxHR: 190,
} as unknown as SettingsState;

const renderEdit = () => {
  const props = {
    plan: current, settings, runs: [], races: null,
    savePlan: vi.fn(), restorePlan: vi.fn(), saveSettings: vi.fn(), buildPlan: vi.fn(() => rebuilt),
    toggleSess: vi.fn(), skipSess: vi.fn(), openSettings: vi.fn(), openCoach: vi.fn(),
    openTracker: vi.fn(), openIndoor: vi.fn(), goLog: vi.fn(), showToast: vi.fn(),
    openEditNonce: 1,
  };
  render(<PlanView {...(props as unknown as React.ComponentProps<typeof PlanView>)}/>);
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  return props;
};

describe("PlanView · rebuilding an existing plan", () => {
  it("previews what changes and saves nothing yet", () => {
    const props = renderEdit();
    expect(screen.getByText("Review changes")).toBeInTheDocument();
    expect(screen.getByText("1 session changes")).toBeInTheDocument();
    expect(screen.getByText("1 completed session kept")).toBeInTheDocument();
    expect(props.savePlan).not.toHaveBeenCalled();
    expect(props.saveSettings).not.toHaveBeenCalled();
  });

  it("keeping the current plan writes nothing", () => {
    const props = renderEdit();
    fireEvent.click(screen.getByRole("button", { name: "Keep current plan" }));
    expect(screen.queryByText("Review changes")).toBeNull();
    expect(props.savePlan).not.toHaveBeenCalled();
    expect(props.saveSettings).not.toHaveBeenCalled();
  });

  it("back returns to the editor without saving", () => {
    const props = renderEdit();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeInTheDocument();
    expect(props.savePlan).not.toHaveBeenCalled();
  });

  it("applying saves the carried plan, and its toast can undo back to the old one", () => {
    const props = renderEdit();
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(props.saveSettings).toHaveBeenCalledTimes(1);
    const saved = props.savePlan.mock.calls[0][0] as Plan;
    // carryProgress kept the elapsed week in front of the rebuilt one.
    expect(saved.weeks[0].sessions[0]).toMatchObject({ date: "2026-09-26", done: true });

    const action = props.showToast.mock.calls[0][2] as ToastAction;
    action.onClick();
    expect(props.restorePlan).toHaveBeenCalledWith(current);
    expect(props.saveSettings).toHaveBeenLastCalledWith(settings);
  });
});
