import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Dashboard } from "./Dashboard";
import { buildOpenPlan } from "../utils/openPlan";
import type { Plan, RacesState, Run, SettingsState } from "../types";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

// A plan with no race, a few days into its first block. Fixed against a pinned clock.
vi.mock("../telemetry", () => ({ track: vi.fn() }));
vi.useFakeTimers({ shouldAdvanceTime: true });
vi.setSystemTime(new Date("2026-09-16T09:00:00"));

const settings = (over: Record<string, unknown> = {}) =>
  ({ name: "Ada", raceDate: "", distanceKm: 10, goalSec: "", targetEditionId: null, goalKind: "open", openTarget: "faster",
    planSessions: [{ dayOffset: 1, minutes: 45 }, { dayOffset: 3, minutes: 45 }, { dayOffset: 6, minutes: 90 }], ...over }) as unknown as SettingsState;
const openPlan = (over: Record<string, unknown> = {}, target: "faster" | "further" | "healthy" = "faster"): Plan => {
  const p = buildOpenPlan(settings(), { target, distanceKm: 10 }, { runs: [] });
  return { ...p, ...over, goal: { ...p.goal!, ...(over.goal as object) } } as Plan;
};
const races: RacesState = { participations: [], seenBadges: null };

const renderDash = (over: Record<string, unknown> = {}) => {
  const props = {
    runs: [] as Run[], plan: openPlan(), settings: settings(), races,
    goTab: vi.fn(), goProgress: vi.fn(), goLog: vi.fn(),
    toggleSess: vi.fn(), skipSess: vi.fn(), linkSess: vi.fn(), unlinkSess: vi.fn(),
    openSettings: vi.fn(), openCoach: vi.fn(), showToast: vi.fn(), saveSettings: vi.fn(), openWhatsNext: vi.fn(),
    ...over,
  };
  render(<Dashboard {...(props as unknown as React.ComponentProps<typeof Dashboard>)} />);
  return props;
};

describe("Dashboard · a plan with no race", () => {
  it("shows what the blocks are for, the block and the next checkpoint, never a race countdown", () => {
    renderDash();
    expect(screen.getByText("Keep improving")).toBeInTheDocument();
    expect(screen.getByText("Faster at 10 km")).toBeInTheDocument();
    expect(screen.getByText(/Block 1 · checkpoint run/)).toBeInTheDocument();
    expect(screen.queryByText("Race Day")).toBeNull();
    expect(screen.queryByText("days to go")).toBeNull();
    expect(screen.queryByText("Set up your race")).toBeNull();
  });

  it("a block plan reads as the runner's own training", () => {
    renderDash({ plan: openPlan({ goal: { kind: "block" } }) });
    expect(screen.getByText("Your training")).toBeInTheDocument();
  });

  it.each([["further", "Running further"], ["healthy", "Staying healthy and consistent"]] as const)("%s", (target, title) => {
    renderDash({ plan: openPlan({}, target) });
    expect(screen.getByText(title)).toBeInTheDocument();
  });

  it("says a lighter plan is lighter", () => {
    renderDash({ plan: openPlan({ goal: { light: true } }) });
    expect(screen.getByText("Faster at 10 km · lighter plan")).toBeInTheDocument();
  });

  it("offers a way to change it, through the what's-next sheet", () => {
    const { openWhatsNext } = renderDash();
    fireEvent.click(screen.getByRole("button", { name: "Change what I'm training for" }));
    expect(openWhatsNext).toHaveBeenCalledTimes(1);
  });

  it("tells a runner whose plan was started for them that it can be changed, and spends the notice once seen", () => {
    const { saveSettings } = renderDash({ plan: openPlan({ goal: { autoFor: "@2026-09-01" } }) });
    expect(screen.getByText(/We started a gentle plan to keep you going/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change this plan" })).toBeInTheDocument();
    // jsdom has no IntersectionObserver, so being mounted counts as seen.
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ autoStartNoticeFor: "@2026-09-01" }));
  });

  it("no notice once it was seen", () => {
    renderDash({ plan: openPlan({ goal: { autoFor: "@2026-09-01" } }), settings: settings({ autoStartNoticeFor: "@2026-09-01" }) });
    expect(screen.queryByText(/We started a gentle plan/)).toBeNull();
  });

  it("lists a wishlisted race that falls inside the plan, whatever the missing race date", () => {
    renderDash({ races: { participations: [{ editionId: "e", status: "wishlist", inPlan: true, label: "Park 10K", raceDate: "2026-10-18", distanceKm: 10 }], seenBadges: null } });
    expect(screen.getByText(/Park 10K · 10km/)).toBeInTheDocument();
  });
});
