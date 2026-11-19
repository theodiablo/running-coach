import { describe, it, expect, afterEach, vi } from "vitest";
import { act, render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Dashboard } from "./Dashboard";
import type { Plan, SettingsState } from "../types";

afterEach(cleanup);

// Fixed "now" so the fixture dates keep their past/future meaning forever.
const NOW = new Date("2026-03-10T09:00:00");
vi.mock("../telemetry", () => ({ track: vi.fn() }));

vi.useFakeTimers({ shouldAdvanceTime: true });
vi.setSystemTime(NOW);

const sess = (id: string, date: string, extra: Record<string, unknown> = {}) =>
  ({id, date, type: "EASY", desc: "Easy run 5km", km: 5, pace: 360, ...extra});

const planOf = (sessions: ReturnType<typeof sess>[]) =>
  ({weeks: [{weekNumber: 1, startDate: "2026-03-09", phase: "base", sessions}]} as unknown as Plan);

const settings = {raceDate: "", distanceKm: "", goalSec: ""} as unknown as SettingsState;

const renderDash = (plan: Plan | null, over: Record<string, unknown> = {}) => {
  const props = {
    runs: [], plan, settings, races: null,
    goTab: vi.fn(), goProgress: vi.fn(), goLog: vi.fn(),
    toggleSess: vi.fn(), skipSess: vi.fn(),
    openSettings: vi.fn(), openCoach: vi.fn(), showToast: vi.fn(),
    ...over,
  };
  render(<Dashboard {...(props as unknown as React.ComponentProps<typeof Dashboard>)} />);
  return props;
};

const didIt = () => screen.queryByRole("button", {name: /^I did it$/});
// "I did it" → "Just tick it off" (DidItSheet); null when the sheet offers no tick.
const markDone = () => {
  if (!screen.queryByRole("dialog")) fireEvent.click(didIt()!);
  return screen.queryByRole("button", {name: /^Just tick it off/});
};

// The bug this whole file exists for: the tick ("Mark as done", now "I did it" → "Just tick it off") edited the plan in silence
// and the card refilled with the NEXT session under the same button, so a
// repeated tap ticked off sessions days or weeks away.
describe("Dashboard next-session card · marking done", () => {
  it("answers the tap with a confirmation instead of silently refilling", () => {
    renderDash(planOf([sess("today", "2026-03-10"), sess("later", "2026-03-12")]));
    fireEvent.click(markDone()!);
    expect(screen.getByText(/is done/)).toBeInTheDocument();
    expect(screen.queryByText("Today's session")).toBeNull();
  });

  it("leaves nothing to tap while the confirmation shows, so a double-tap can't consume the next session", () => {
    const props = renderDash(planOf([sess("today", "2026-03-10"), sess("later", "2026-03-12")]));
    fireEvent.click(markDone()!);
    expect(didIt()).toBeNull();
    expect(screen.queryByRole("button", {name: /Skip/})).toBeNull();
    expect(props.toggleSess).toHaveBeenCalledTimes(1);
  });

  it("undoes exactly the session it ticked off", () => {
    const props = renderDash(planOf([sess("today", "2026-03-10")]));
    fireEvent.click(markDone()!);
    fireEvent.click(screen.getByRole("button", {name: /Undo/}));
    // toggleSess is its own inverse: the same call again puts it back.
    expect(props.toggleSess).toHaveBeenCalledTimes(2);
    expect(props.toggleSess).toHaveBeenLastCalledWith(1, "today");
    expect(screen.queryByText(/is done/)).toBeNull();
    expect(didIt()).not.toBeNull();
  });

  it("advances to the next session once the confirmation has been seen", () => {
    renderDash(planOf([sess("today", "2026-03-10")]));
    fireEvent.click(markDone()!);
    act(() => { vi.advanceTimersByTime(2600); });
    expect(screen.queryByText(/is done/)).toBeNull();
  });

  it("confirms a skip the same way", () => {
    const props = renderDash(planOf([sess("today", "2026-03-10")]));
    fireEvent.click(screen.getByRole("button", {name: /Skip/}));
    expect(props.skipSess).toHaveBeenCalledWith(1, "today");
    expect(screen.getByText(/skipped/)).toBeInTheDocument();
  });

  it("never offers the tick on a session dated in the future", () => {
    renderDash(planOf([sess("later", "2026-03-12")]));
    expect(screen.getByText("Up next")).toBeInTheDocument();
    expect(markDone()).toBeNull();
    expect(screen.getByText(/You can tick this off on/)).toBeInTheDocument();
    // Skipping ahead is still legitimate — you can know you'll miss Sunday.
    expect(screen.getByRole("button", {name: /Skip/})).toBeInTheDocument();
  });

  it("offers the tick on today's session", () => {
    renderDash(planOf([sess("today", "2026-03-10")]));
    expect(markDone()).not.toBeNull();
    expect(screen.queryByText(/You can tick this off on/)).toBeNull();
  });
});

describe("Dashboard next-session card · I did it", () => {
  it("offers the run's details first, opening the form prefilled from the session", () => {
    const props = renderDash(planOf([sess("today", "2026-03-10")]));
    fireEvent.click(didIt()!);
    fireEvent.click(screen.getByRole("button", {name: /^Add the run's details/}));
    expect(props.goLog).toHaveBeenCalledWith(expect.objectContaining({type: "EASY", km: 5}));
    expect(props.toggleSess).not.toHaveBeenCalled();
  });

  it("carries two verbs, not five", () => {
    renderDash(planOf([sess("today", "2026-03-10")]));
    expect(screen.queryByRole("button", {name: /Log it|Mark as done|I already ran this/})).toBeNull();
  });
});

describe("Dashboard overdue rows · feedback", () => {
  it("toasts with an undo that puts the session back", () => {
    const props = renderDash(planOf([sess("missed", "2026-03-08")]));
    fireEvent.click(screen.getByRole("button", {name: "Done"}));
    expect(props.toggleSess).toHaveBeenCalledWith(1, "missed");
    const [msg, , action] = vi.mocked(props.showToast).mock.calls[0] as [string, string, {label: string; onClick: () => void}];
    expect(msg).toBe("Session ticked off");
    action.onClick();
    expect(props.toggleSess).toHaveBeenCalledTimes(2);
  });
});

describe("Dashboard · a calmer Home", () => {
  it("shows one thing that needs attention at a time", () => {
    // An open session and a badge in reach: only the open session shows.
    renderDash(planOf([sess("missed", "2026-03-08")]),
      {runs: [{id: "r1", date: "2026-03-09", type: "EASY", km: 4, durationSec: 1500}]});
    expect(screen.getByText("1 session still open")).toBeInTheDocument();
    // The stretch suggestion, next in line, waits its turn.
    expect(screen.queryByText(/^Cool down/)).toBeNull();
  });

  it("always keeps the next badge in reach, in the week card", () => {
    renderDash(planOf([sess("missed", "2026-03-08")]),
      {runs: [{id: "r1", date: "2026-03-09", type: "EASY", km: 4, durationSec: 1500}]});
    expect(screen.getByText(/Next badge/).closest("button")!.textContent).toBe("Next badge · First 5K · 1 km to go");
  });

  it("sums the week up in one line instead of stat tiles", () => {
    renderDash(planOf([sess("mon", "2026-03-09", {done: true}), sess("today", "2026-03-10")]),
      {runs: [{id: "r1", date: "2026-03-09", type: "EASY", km: 5.4, durationSec: 1800}]});
    expect(screen.getByText("This week")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 sessions · 5.4 km")).toBeInTheDocument();
    expect(screen.queryByText("Runs recorded")).toBeNull();
  });
});
