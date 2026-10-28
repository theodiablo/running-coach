import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PlanView } from "./PlanView";
import type { Plan, SettingsState } from "../types";

afterEach(cleanup);
vi.mock("../telemetry", () => ({ track: vi.fn() }));

// Fixed against this clock; nothing here builds a plan.
const NOW = new Date("2026-09-27T09:00:00");
vi.useFakeTimers({ shouldAdvanceTime: true });
vi.setSystemTime(NOW);

const sess = (id: string, date: string, type: string, extra: Record<string, unknown> = {}) =>
  ({ id, date, type, km: 10, pace: 365, desc: type + " run", ...extra });

const planWith = (raceDate: string, raceExtra: Record<string, unknown> = {}) => ({
  raceDate, distanceKm: 10, goalSec: 7200,
  weeks: [{ weekNumber: 1, startDate: "2026-09-21", phase: "RACE", sessions: [
    sess("race", raceDate, "RACE", raceExtra),
  ] }],
}) as unknown as Plan;

const settingsOf = (raceDate: string, extra: Record<string, unknown> = {}) => ({
  raceDate, distanceKm: 10, goalSec: "", raceElevation: 0, planStyle: "balanced", targetEditionId: null,
  availabilityMode: "custom", planSessions: [{ dayOffset: 3, minutes: 45 }, { dayOffset: 6, minutes: 75 }], maxHR: 190, ...extra,
}) as unknown as SettingsState;

const renderPlan = (over: Record<string, unknown> = {}) => {
  const props = {
    plan: planWith("2026-09-26"), settings: settingsOf("2026-09-26"), runs: [], races: null,
    savePlan: vi.fn(), restorePlan: vi.fn(), saveSettings: vi.fn(), buildPlan: vi.fn(),
    toggleSess: vi.fn(), skipSess: vi.fn(), openSettings: vi.fn(), openCoach: vi.fn(),
    openTracker: vi.fn(), openIndoor: vi.fn(), goLog: vi.fn(), showToast: vi.fn(),
    ...over,
  };
  const view = render(<PlanView {...(props as unknown as React.ComponentProps<typeof PlanView>)}/>);
  return { props, view };
};

const dateInput = (c: HTMLElement) => c.querySelector('input[type="date"]') as HTMLInputElement;

describe("PlanView · after the race", () => {
  it("says the race is over instead of counting down to it, and offers the next goal", () => {
    renderPlan();
    expect(screen.queryByText(/Race in \d+ days/)).toBeNull();
    expect(screen.getByText(/Race day was/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set your next goal" })).toBeInTheDocument();
  });

  it("still counts down before the race", () => {
    renderPlan({ plan: planWith("2026-10-20"), settings: settingsOf("2026-10-20") });
    expect(screen.getByText("Race in 23 days")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set your next goal" })).toBeNull();
  });

  it("never shows the plan's substituted 2:00:00 as the runner's goal", () => {
    renderPlan({ plan: planWith("2026-10-20"), settings: settingsOf("2026-10-20", { goalSec: "" }) });
    expect(screen.queryByText(/2:00:00/)).toBeNull();
  });

  it("opens the editor on an empty, future-only date and blocks building until one is picked", () => {
    const { view } = renderPlan();
    fireEvent.click(screen.getByRole("button", { name: "Set your next goal" }));
    const input = dateInput(view.container);
    expect(input.value).toBe("");
    expect(input.min).toBe("2026-09-28");
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "2026-09-27" } });
    expect(screen.getByText("Pick a race date after today.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "2026-10-25" } });
    expect(screen.queryByText("Pick a race date after today.")).toBeNull();
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeEnabled();
  });

  it("keeps a still-future race date when the editor opens", () => {
    const { view } = renderPlan({ plan: planWith("2026-10-20"), settings: settingsOf("2026-10-20") });
    fireEvent.click(screen.getAllByRole("button", { name: /Edit/ })[0]);
    expect(dateInput(view.container).value).toBe("2026-10-20");
  });
});
