import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PlanView } from "./PlanView";
import { buildPlan } from "../utils/plan";
import { buildOpenPlan } from "../utils/openPlan";
import type { Plan, SettingsState } from "../types";

afterEach(cleanup);
vi.mock("../telemetry", () => ({ track: vi.fn() }));

vi.useFakeTimers({ shouldAdvanceTime: true });
vi.setSystemTime(new Date("2026-09-16T09:00:00"));

const SESSIONS = [{ dayOffset: 1, minutes: 45 }, { dayOffset: 3, minutes: 45 }, { dayOffset: 6, minutes: 90 }];
const settingsOf = (extra: Record<string, unknown> = {}) => ({
  raceDate: "", distanceKm: 10, goalSec: "", raceElevation: 0, planStyle: "balanced", targetEditionId: null,
  availabilityMode: "custom", planSessions: SESSIONS, maxHR: 190, ...extra,
}) as unknown as SettingsState;
const openPlan = (target: "faster" | "further" | "healthy" = "faster") =>
  buildOpenPlan(settingsOf(), { target, distanceKm: 10 }, { runs: [] });
const racePlan = () => buildPlan("2026-12-13", 3000, SESSIONS, 10, 0, { recovery: true }) as unknown as Plan;

const renderPlan = (over: Record<string, unknown> = {}) => {
  const props = {
    plan: openPlan(), settings: settingsOf({ goalKind: "open", openTarget: "faster" }), runs: [], races: null,
    savePlan: vi.fn(), restorePlan: vi.fn(), saveSettings: vi.fn(), buildPlan: vi.fn(),
    toggleSess: vi.fn(), skipSess: vi.fn(), openSettings: vi.fn(), openCoach: vi.fn(),
    openTracker: vi.fn(), openIndoor: vi.fn(), goLog: vi.fn(), showToast: vi.fn(), editSession: vi.fn(),
    ...over,
  };
  render(<PlanView {...(props as unknown as React.ComponentProps<typeof PlanView>)}/>);
  return props;
};

describe("PlanView · a plan with no race", () => {
  it("heads the plan with the block and its checkpoint instead of counting down to a race", () => {
    renderPlan();
    expect(screen.queryByText(/Race in \d+ days/)).toBeNull();
    expect(screen.getByText(/^Block 1 · checkpoint \w+ \d+ \w+$/)).toBeInTheDocument();
    expect(screen.getByText("Get faster · 10 km")).toBeInTheDocument();
  });

  it("has no finished-race button", () => {
    renderPlan();
    expect(screen.queryByRole("button", { name: "Set your next goal" })).toBeNull();
  });

  it("the goal editor opens on Keep improving, with the plan's target selected", () => {
    renderPlan();
    fireEvent.click(screen.getByRole("button", { name: /Your goal.*Edit$/ }));
    expect(screen.getByRole("button", { name: "Keep improving" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Get faster/ })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector('input[type="date"]')).toBeNull();
  });

  it("switching a race plan to Keep improving rebuilds it with no race, after a preview", () => {
    const props = renderPlan({ plan: racePlan(), settings: settingsOf({ raceDate: "2026-12-13", goalSec: 3000 }) });
    fireEvent.click(screen.getByRole("button", { name: /Your goal.*Edit$/ }));
    expect(screen.getByRole("button", { name: "Race" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Keep improving" }));
    fireEvent.click(screen.getByRole("button", { name: /Run further/ }));
    fireEvent.click(screen.getByRole("button", { name: /^A lighter plan/ }));
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(props.savePlan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(props.savePlan).toHaveBeenCalledTimes(1);
    expect(props.savePlan.mock.calls[0][0].goal).toMatchObject({ kind: "open", target: "further", light: true });
    expect(props.saveSettings.mock.calls[0][0]).toMatchObject({ goalKind: "open", openTarget: "further", lightPlan: true, raceDate: "", targetEditionId: null });
  });

  it("first-time setup can start Keep improving without ever asking for a date", () => {
    const props = renderPlan({ plan: null, settings: settingsOf() });
    fireEvent.click(screen.getByRole("button", { name: "Keep improving" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate My Training Plan" }));
    expect(props.savePlan.mock.calls[0][0].goal).toMatchObject({ kind: "open", target: "healthy" });
    expect(props.saveSettings.mock.calls[0][0]).toMatchObject({ goalKind: "open", raceDate: "" });
  });

  it("switching an open plan back to a race needs a date again", () => {
    renderPlan();
    fireEvent.click(screen.getByRole("button", { name: /Your goal.*Edit$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Race" }));
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeDisabled();
  });
});

describe("PlanView · finished race", () => {
  it("'Set your next goal' opens the what's-next sheet when the hub offers one", () => {
    const openWhatsNext = vi.fn();
    const done = racePlan();
    const raceDay = "2026-09-12";
    renderPlan({ plan: { ...done, raceDate: raceDay, weeks: [{ weekNumber: 1, startDate: "2026-09-07", phase: "RACE",
      sessions: [{ id: "race", date: raceDay, type: "RACE", km: 10, pace: 300, desc: "Race", done: true }] }] }, openWhatsNext,
      settings: settingsOf({ raceDate: raceDay }) });
    fireEvent.click(screen.getByRole("button", { name: "Set your next goal" }));
    expect(openWhatsNext).toHaveBeenCalledTimes(1);
  });
});
