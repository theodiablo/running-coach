import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import { Dashboard } from "./Dashboard";
import type { Plan, SettingsState } from "../types";

afterEach(cleanup);

// Fixed "now" so the fixture dates keep their past/future meaning forever.
const NOW = new Date("2026-03-10T09:00:00");
vi.useFakeTimers({ shouldAdvanceTime: true });
vi.setSystemTime(NOW);

const sess = (id: string, date: string, extra: Record<string, unknown> = {}) =>
  ({id, date, type: "EASY", desc: "Easy run 5km", km: 5, pace: 360, ...extra});

const planOf = (sessions: ReturnType<typeof sess>[]) =>
  ({weeks: [{weekNumber: 1, startDate: "2026-03-02", phase: "base", sessions}]} as unknown as Plan);

const settings = {raceDate: "", distanceKm: "", goalSec: ""} as unknown as SettingsState;

const renderDash = (plan: Plan | null, over: Record<string, unknown> = {}) => {
  const props = {
    runs: [], plan, settings, races: null,
    goTab: vi.fn(), goProgress: vi.fn(), goLog: vi.fn(),
    toggleSess: vi.fn(), skipSess: vi.fn(),
    openSettings: vi.fn(), openCoach: vi.fn(),
    ...over,
  };
  render(<Dashboard {...(props as unknown as React.ComponentProps<typeof Dashboard>)} />);
  return props;
};

describe("Dashboard overdue card", () => {
  it("surfaces sessions the runner never got to, instead of silently skipping them", () => {
    // The regression this whole feature exists for: before it, a session dated
    // in the past simply vanished and the card jumped to the next future one.
    renderDash(planOf([sess("missed", "2026-03-08"), sess("future", "2026-03-12")]));
    expect(screen.getByText("1 session still open")).toBeInTheDocument();
  });

  it("renders nothing when every past session was handled", () => {
    renderDash(planOf([
      sess("a", "2026-03-06", {done: true}),
      sess("b", "2026-03-07", {skipped: true}),
      sess("c", "2026-03-12"),
    ]));
    expect(screen.queryByText(/still open/)).toBeNull();
  });

  it("caps the rows at three and points the rest into the plan", () => {
    const props = renderDash(planOf([
      sess("a", "2026-03-01"), sess("b", "2026-03-02"), sess("c", "2026-03-03"),
      sess("d", "2026-03-04"), sess("e", "2026-03-05"),
    ]));
    expect(screen.getByText("5 sessions still open")).toBeInTheDocument();
    // Three Done buttons = three rendered rows, not five.
    expect(screen.getAllByRole("button", {name: "Done"})).toHaveLength(3);
    fireEvent.click(screen.getByText("2 more in your plan"));
    expect(props.goTab).toHaveBeenCalledWith("plan");
  });

  it("ticks the freshest overdue session with the right week and id", () => {
    const props = renderDash(planOf([sess("older", "2026-03-05"), sess("newer", "2026-03-08")]));
    // Most recent first, so the first row is the freshest miss.
    fireEvent.click(screen.getAllByRole("button", {name: "Done"})[0]);
    expect(props.toggleSess).toHaveBeenCalledWith(1, "newer");
  });

  it("skips an overdue session", () => {
    const props = renderDash(planOf([sess("missed", "2026-03-08")]));
    fireEvent.click(screen.getByRole("button", {name: "Skip"}));
    expect(props.skipSess).toHaveBeenCalledWith(1, "missed");
  });

  it("offers the coach as the forgiving way out", () => {
    const props = renderDash(planOf([sess("missed", "2026-03-08")]));
    fireEvent.click(screen.getByRole("button", {name: /Adjust my plan/}));
    expect(props.openCoach).toHaveBeenCalledWith(null, "dashboard");
  });

  it("keeps showing the next upcoming session alongside the backlog", () => {
    renderDash(planOf([sess("missed", "2026-03-08"), sess("soon", "2026-03-12")]));
    expect(screen.getByText("1 session still open")).toBeInTheDocument();
    expect(screen.getByText("Up next")).toBeInTheDocument();
  });

  it("never lists the upcoming session as overdue", () => {
    renderDash(planOf([sess("today", "2026-03-10")]));
    expect(screen.queryByText(/still open/)).toBeNull();
    expect(screen.getByText("Today's session")).toBeInTheDocument();
  });

  it("uses forgiving wording — no shaming, no streak language", () => {
    renderDash(planOf([sess("missed", "2026-03-08")]));
    const card = screen.getByText("1 session still open").closest("div")!.parentElement!.parentElement!;
    expect(within(card).queryByText(/missed|failed|streak|broke/i)).toBeNull();
  });
});
