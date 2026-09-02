import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Dashboard } from "./Dashboard";
import type { Plan, Run, SettingsState } from "../types";

afterEach(cleanup);

// Wednesday. The session under test is Thursday's — the case the whole feature
// exists for: the run is recorded, the session is a day ahead, and until now
// nothing could bring the two together.
const NOW = new Date("2026-03-11T09:00:00");
vi.mock("../telemetry", () => ({ track: vi.fn() }));
vi.useFakeTimers({ shouldAdvanceTime: true });
vi.setSystemTime(NOW);

const thursday = {
  id: "w3d3", date: "2026-03-12", type: "TEMPO", desc: "Tempo 8km", km: 8, pace: 300,
};

const planOf = (sessions: Record<string, unknown>[], startDate = "2026-03-09") =>
  ({weeks: [{weekNumber: 3, startDate, phase: "build", sessions}]} as unknown as Plan);

const settings = {raceDate: "", distanceKm: "", goalSec: ""} as unknown as SettingsState;

const wednesdayRun = {id: "r1", date: "2026-03-11", type: "TEMPO", km: 8.2, durationSec: 2412} as Run;

const renderDash = (over: Record<string, unknown> = {}) => {
  const props = {
    runs: [wednesdayRun], plan: planOf([thursday]), settings, races: null,
    goTab: vi.fn(), goProgress: vi.fn(), goLog: vi.fn(),
    toggleSess: vi.fn(), skipSess: vi.fn(), linkSess: vi.fn(), unlinkSess: vi.fn(),
    openSettings: vi.fn(), openCoach: vi.fn(), showToast: vi.fn(),
    ...over,
  };
  render(<Dashboard {...(props as unknown as React.ComponentProps<typeof Dashboard>)} />);
  return props;
};

const alreadyRan = () => screen.queryByRole("button", {name: "I already ran this"});

describe("Dashboard next-session card · reconciling an already-recorded run", () => {
  it("offers the reconcile route instead of telling you to come back tomorrow", () => {
    renderDash();
    expect(alreadyRan()).not.toBeNull();
    expect(screen.queryByText(/You can tick this off on/)).toBeNull();
  });

  it("still says come back tomorrow when there is no run it could be", () => {
    renderDash({runs: []});
    expect(alreadyRan()).toBeNull();
    expect(screen.getByText(/You can tick this off on/)).toBeInTheDocument();
  });

  // The cross-training line: a bike ride is not a tempo.
  it("does not offer a cross-training entry against a running session", () => {
    renderDash({runs: [{id: "r9", date: "2026-03-11", type: "OTHER", km: 0, durationSec: 2400} as Run]});
    expect(alreadyRan()).toBeNull();
  });

  it("links the chosen run and moves the session onto the day it happened", () => {
    const props = renderDash();
    fireEvent.click(alreadyRan()!);
    expect(screen.getByRole("radio", {name: /8\.2 km/})).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name: "Count it"}));
    expect(props.linkSess).toHaveBeenCalledWith(3, "w3d3", "r1", "2026-03-11");
  });

  it("leaves the session where it is when the move is declined", () => {
    const props = renderDash();
    fireEvent.click(alreadyRan()!);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", {name: "Count it"}));
    expect(props.linkSess).toHaveBeenCalledWith(3, "w3d3", "r1", undefined);
  });

  // Re-dating outside the week would file the session under a week it no longer
  // falls in, so the offer isn't made at all.
  it("never offers to move a session out of its own week", () => {
    renderDash({plan: planOf([{...thursday, date: "2026-03-14"}], "2026-03-14")});
    fireEvent.click(alreadyRan()!);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("confirms in place, naming the run that settled it", () => {
    renderDash();
    fireEvent.click(alreadyRan()!);
    fireEvent.click(screen.getByRole("button", {name: "Count it"}));
    expect(screen.getByText(/Tempo/)).toBeInTheDocument();
    expect(screen.getByText(/8\.2 km in 40:12/)).toBeInTheDocument();
  });

  // Undo can't be "the same call again" here: the link has to be released and
  // the session put back on the day it used to sit on.
  it("undoes by unlinking and restoring the original date", () => {
    const props = renderDash();
    fireEvent.click(alreadyRan()!);
    fireEvent.click(screen.getByRole("button", {name: "Count it"}));
    fireEvent.click(screen.getByRole("button", {name: /Undo/}));
    expect(props.unlinkSess).toHaveBeenCalledWith(3, "w3d3", "2026-03-12");
    expect(props.toggleSess).not.toHaveBeenCalled();
  });

  it("closes without touching the plan on cancel", () => {
    const props = renderDash();
    fireEvent.click(alreadyRan()!);
    fireEvent.click(screen.getByRole("button", {name: "Cancel"}));
    expect(props.linkSess).not.toHaveBeenCalled();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  // One day later the same run is still the one that settled the session — the
  // only action left on an overdue row used to be the evidence-free tick.
  it("offers the same route from an overdue row", () => {
    const props = renderDash({plan: planOf([{...thursday, date: "2026-03-09"}])});
    fireEvent.click(screen.getByRole("button", {name: "I already ran this"}));
    fireEvent.click(screen.getByRole("button", {name: "Count it"}));
    expect(props.linkSess).toHaveBeenCalledWith(3, "w3d3", "r1", "2026-03-11");
  });

  it("leaves an overdue row's bare tick alone when no run could be it", () => {
    renderDash({runs: [], plan: planOf([{...thursday, date: "2026-03-09"}])});
    expect(screen.queryByRole("button", {name: "I already ran this"})).toBeNull();
    expect(screen.getByRole("button", {name: "Done"})).toBeInTheDocument();
  });

  it("never offers a run another session already claims", () => {
    renderDash({plan: planOf([{id: "w3d1", date: "2026-03-10", type: "EASY", desc: "Easy 6km", km: 6, pace: 360, done: true, runId: "r1"}, thursday])});
    expect(alreadyRan()).toBeNull();
  });
});
