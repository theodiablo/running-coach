import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RaceRow } from "./RaceRow";
import type { CatalogueRace } from "../../types";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-21T10:00:00") }));
afterEach(() => { cleanup(); vi.useRealTimers(); });

const race = (dates: string[]): CatalogueRace => ({
  id: "r", name: "Memorial Juanlu", city: "Lasarte-Oria", country: "ES", verified: true,
  editions: dates.map(date => ({ id: "e-" + date, date, distanceKm: 14.5 })),
});
const row = (r: CatalogueRace) =>
  render(<RaceRow race={r} editions={r.editions as never} highlightKm={() => false} onList={false} isTarget={false} onOpen={() => {}}/>);

describe("RaceRow", () => {
  it("says a race whose dates are all behind it has no upcoming date", () => {
    row(race(["2026-09-26"]));
    expect(screen.getByText("No upcoming date")).toBeInTheDocument();
  });
  it("says nothing of the kind when a next edition is announced", () => {
    row(race(["2026-09-26", "2027-09-25"]));
    expect(screen.queryByText("No upcoming date")).toBeNull();
  });
  it("counts a race held today as upcoming", () => {
    row(race(["2026-11-21"]));
    expect(screen.queryByText("No upcoming date")).toBeNull();
  });
});
