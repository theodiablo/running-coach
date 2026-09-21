import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { StatsView } from "./StatsView";
import { hydrateCatalogue } from "../utils/races";
import type { RacesState, Run, SettingsState } from "../types";

afterEach(cleanup);

// Runs are only here to give both models something to anchor on; what the tests
// below check is which races get a card, not what the numbers come out at.
const run = (date: string, km: number, durationSec: number, hr: number): Run =>
  ({ id: date, date, type: "EASY", km, durationSec, hr } as unknown as Run);

const RUNS: Run[] = Array.from({length: 12}, (_, i) => {
  const day = String(8 + i).padStart(2, "0");
  return run(`2026-09-${day}`, 8, 2900 + i * 40, 142 + i * 2);
});

const SETTINGS = {
  raceDate: "2026-11-08", distanceKm: 20, goalSec: 6300, raceElevation: 200,
  targetEditionId: "behobia-2026", maxHR: 188, restHR: 50,
} as unknown as SettingsState;

const RACES = {
  seenBadges: [],
  participations: [
    { editionId: "lasarte-2026", label: "Lasarte trail", raceDate: "2026-09-26", distanceKm: 14.5, status: "wishlist" },
    { editionId: "behobia-2026", label: "Behobia-San Sebastián", raceDate: "2026-11-08", distanceKm: 20, status: "wishlist" },
  ],
} as unknown as RacesState;

const view = (over: Partial<Parameters<typeof StatsView>[0]> = {}) =>
  render(<StatsView runs={RUNS} settings={SETTINGS} races={RACES} {...over}/>);

const card = (name: string | RegExp) => screen.getByText(name).closest("div.bg-slate-800") as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T09:00:00"));
  hydrateCatalogue([
    { id: "behobia", name: "Behobia-San Sebastián",
      editions: [{ id: "behobia-2026", date: "2026-11-08", distanceKm: 20, elevation: 200 }] },
    { id: "lasarte", name: "Lasarte trail",
      editions: [{ id: "lasarte-2026", date: "2026-09-26", distanceKm: 14.5 }] },
  ] as never);
});

afterEach(() => { vi.useRealTimers(); hydrateCatalogue([]); });

describe("StatsView race predictions", () => {
  it("gives each upcoming race its own card, soonest first", () => {
    view();
    const names = screen.getAllByText(/Lasarte trail|Behobia-San Sebastián/).map(n => n.textContent);
    expect(names).toEqual(["Lasarte trail", "Behobia-San Sebastián"]);
  });

  it("counts down to each race", () => {
    view();
    expect(within(card("Lasarte trail")).getByText("in 5 days")).toBeInTheDocument();
    expect(within(card("Behobia-San Sebastián")).getByText("in 48 days")).toBeInTheDocument();
  });

  it("puts the goal and both gaps on the target race, and nowhere else", () => {
    view();
    const goal = card("Behobia-San Sebastián");
    expect(within(goal).getByText("Your goal")).toBeInTheDocument();
    expect(within(goal).getByText("1:45:00")).toBeInTheDocument();
    expect(within(goal).getByText(/Your best day has you/)).toBeInTheDocument();
    expect(within(card("Lasarte trail")).queryByText("Your goal")).not.toBeInTheDocument();
  });

  // A trail race projected as flat reads absurdly optimistic, so the card says so.
  it("flags a race with no climb on record, and offers the goal race a way to set it", () => {
    const goTab = vi.fn();
    view({ goTab });
    const lasarte = card("Lasarte trail");
    expect(within(lasarte).getByText(/no climb on record/)).toBeInTheDocument();
    expect(within(lasarte).queryByRole("button", {name: "Add climb"})).not.toBeInTheDocument();

    const behobia = card("Behobia-San Sebastián");
    expect(within(behobia).queryByText(/no climb on record/)).not.toBeInTheDocument();
    expect(within(behobia).getByText(/\+200 m/)).toBeInTheDocument();
  });

  it("sends the goal race's missing climb to the Plan tab", () => {
    // Neither the catalogue nor the plan knows this course's climb.
    hydrateCatalogue([{ id: "behobia", name: "Behobia-San Sebastián",
      editions: [{ id: "behobia-2026", date: "2026-11-08", distanceKm: 20 }] }] as never);
    const goTab = vi.fn();
    view({ goTab, settings: {...SETTINGS, raceElevation: 0} as unknown as SettingsState });

    fireEvent.click(within(card("Behobia-San Sebastián")).getByRole("button", {name: "Add climb"}));
    expect(goTab).toHaveBeenCalledWith("plan");
  });

  it("collapses the standard ladder behind a toggle while real races exist", () => {
    view();
    expect(screen.queryByText("10 km")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name: /Other distances/}));
    expect(screen.getByText("10 km")).toBeInTheDocument();
  });

  it("falls back to the open ladder when nothing is on the calendar", () => {
    view({ races: null, settings: {...SETTINGS, raceDate: "", distanceKm: ""} as unknown as SettingsState });
    expect(screen.getByText("5 km")).toBeInTheDocument();
    expect(screen.getByText("20 km")).toBeInTheDocument();
    expect(screen.queryByRole("button", {name: /Other distances/})).not.toBeInTheDocument();
  });
});
