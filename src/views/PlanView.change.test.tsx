import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { PlanView } from "./PlanView";
import { buildPlan } from "../utils/plan";
import { track } from "../telemetry";
import type { Plan, SettingsState } from "../types";

afterEach(() => { cleanup(); vi.mocked(track).mockClear(); });
vi.mock("../telemetry", () => ({ track: vi.fn() }));

vi.useFakeTimers({ shouldAdvanceTime: true });
vi.setSystemTime(new Date("2026-09-16T09:00:00"));

const SESSIONS = [{ dayOffset: 1, minutes: 45 }, { dayOffset: 3, minutes: 45 }, { dayOffset: 6, minutes: 90 }];
const RACE = "2026-12-13";
const settings = {
  raceDate: RACE, distanceKm: 10, goalSec: 3000, raceElevation: 0, planStyle: "balanced", targetEditionId: null,
  availabilityMode: "custom", planSessions: SESSIONS, maxHR: 190,
} as unknown as SettingsState;
const plan = () => buildPlan(RACE, 3000, SESSIONS, 10, 0, { recovery: true }) as unknown as Plan;

const renderPlan = (over: Record<string, unknown> = {}) => {
  const props = {
    plan: plan(), settings, runs: [], races: null,
    savePlan: vi.fn(), restorePlan: vi.fn(), saveSettings: vi.fn(), buildPlan: vi.fn(),
    toggleSess: vi.fn(), skipSess: vi.fn(), openSettings: vi.fn(), openCoach: vi.fn(),
    openTracker: vi.fn(), openIndoor: vi.fn(), goLog: vi.fn(), showToast: vi.fn(), editSession: vi.fn(),
    ...over,
  };
  render(<PlanView {...(props as unknown as React.ComponentProps<typeof PlanView>)}/>);
  return props;
};
const openSheet = () => fireEvent.click(screen.getByRole("button", { name: "Change my plan" }));
const pick = (name: RegExp) => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name }));

describe("PlanView · Change my plan", () => {
  it("says what the plan is for in one sentence, with one button to change it", () => {
    renderPlan();
    expect(screen.getByText("10 km race · 13 Dec")).toBeInTheDocument();
    expect(screen.getByText(/^Aiming for 50:00\. 3 runs a week: .*\. Style: Balanced\.$/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit$/ })).toBeNull();
  });

  it("asks what to change, with every kind of change listed", () => {
    renderPlan();
    openSheet();
    expect(screen.getByText("What do you want to change?")).toBeInTheDocument();
    for (const name of [/^My race or goal time/, /^The days I can run/, /^How hard it feels/, /^Just one session/, /^Something else/])
      expect(within(screen.getByRole("dialog")).getByRole("button", { name })).toBeInTheDocument();
    expect(track).toHaveBeenCalledWith("plan_change_opened", { source: "plan" });
  });

  it("the days answer opens only the running days, then the usual preview", () => {
    renderPlan();
    openSheet();
    pick(/^The days I can run/);
    expect(screen.getByRole("heading", { name: "Your running days" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Simple" })).toBeInTheDocument();
    expect(document.querySelector('input[type="date"]')).toBeNull();
    expect(screen.queryByText("Training style")).toBeNull();
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeEnabled();
    expect(track).toHaveBeenCalledWith("plan_change_picked", { choice: "avail" });
  });

  it("the style answer opens only the style picker", () => {
    renderPlan();
    openSheet();
    pick(/^How hard it feels/);
    expect(screen.getByRole("heading", { name: "How hard it feels" })).toBeInTheDocument();
    expect(document.querySelector('input[type="date"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Simple" })).toBeNull();
  });

  it("back from a single part returns to the plan without saving", () => {
    const props = renderPlan();
    openSheet();
    pick(/^My race or goal time/);
    expect(screen.getByRole("heading", { name: "Your race or goal" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Change my plan" })).toBeInTheDocument();
    expect(props.savePlan).not.toHaveBeenCalled();
  });

  it("something else hands the runner to the coach", () => {
    const props = renderPlan();
    openSheet();
    pick(/^Something else/);
    expect(props.openCoach).toHaveBeenCalledWith(null, "change_plan");
  });

  it("one session points at the sessions, each with a visible Change", () => {
    renderPlan();
    openSheet();
    pick(/^Just one session/);
    expect(screen.getByText("Tap Change on the session you want to move, shorten or swap.")).toBeInTheDocument();
    const changes = screen.getAllByRole("button", { name: "Change" });
    expect(changes.length).toBeGreaterThan(0);
    fireEvent.click(changes[0]);
    expect(screen.queryByText(/^Tap Change on the session/)).toBeNull();
  });

  it("arrives on the sheet when a door elsewhere asked for it", () => {
    renderPlan({ openChangeNonce: 1 });
    expect(screen.getByText("What do you want to change?")).toBeInTheDocument();
  });
});

describe("PlanView · I did it on a session", () => {
  const today = { id: "w1d3", date: "2026-09-16", type: "EASY", desc: "Easy run", km: 5, pace: 360 };
  const todayPlan = () => ({ ...plan(), weeks: [{ weekNumber: 1, startDate: "2026-09-14", phase: "BASE", sessions: [today] }] }) as unknown as Plan;

  it("ticks a session off without a run when that's all the runner wants", () => {
    const props = renderPlan({ plan: todayPlan() });
    fireEvent.click(screen.getByRole("button", { name: "I did it" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Just tick it off/ }));
    expect(props.toggleSess).toHaveBeenCalledWith(1, "w1d3");
  });

  it("opens the form for the run's details", () => {
    const props = renderPlan({ plan: todayPlan() });
    fireEvent.click(screen.getByRole("button", { name: "I did it" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Add the run's details/ }));
    expect(props.goLog).toHaveBeenCalledWith(expect.objectContaining({ date: "2026-09-16", km: 5 }));
  });
});
