import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { RaceSheet } from "./RaceSheet";
import type { CatalogueRace, SettingsState } from "../types";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-21T10:00:00") }));
afterEach(() => { cleanup(); vi.useRealTimers(); });

const race = (dates: string[], url: string | null = "https://www.zurichmaratobarcelona.es/"): CatalogueRace => ({
  id: "r", slug: "barcelona-marathon", name: "Barcelona Marathon", city: "Barcelona", country: "ES", verified: true, url,
  editions: dates.map(date => ({ id: "e-" + date, date, distanceKm: 42.2 })),
});
const sheet = (r: CatalogueRace, editionId: string | null = null) => render(
  <RaceSheet race={r} editionId={editionId} byId={{}} settings={{} as SettingsState} runs={[]}
    addWishlist={vi.fn()} setGoal={vi.fn()} removePart={vi.fn()} promote={vi.fn()} saveResult={vi.fn()} report={vi.fn()} onClose={vi.fn()}/>);

describe("RaceSheet · official site", () => {
  it("offers sign-up on the official site of an upcoming race, naming the site", () => {
    sheet(race(["2027-03-14"]));
    const link = screen.getByRole("link", { name: /Sign up on the official site/ });
    expect(link).toHaveAttribute("href", "https://www.zurichmaratobarcelona.es/");
    expect(link).toHaveTextContent("zurichmaratobarcelona.es");
  });
  it("just points at the official site when no date is upcoming", () => {
    sheet(race(["2026-03-15"]));
    expect(screen.getByRole("link", { name: /Official site/ })).toBeInTheDocument();
    expect(screen.queryByText("Sign up on the official site")).toBeNull();
  });
  it("shows no button without a site", () => {
    sheet(race(["2027-03-14"], null));
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("RaceSheet · past editions", () => {
  it("keeps last year's edition behind a link beside the next one", () => {
    sheet(race(["2026-03-15", "2027-03-14"]));
    expect(screen.queryByRole("button", { name: /15 Mar/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 1 past edition" }));
    expect(screen.getByRole("button", { name: /15 Mar/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /14 Mar/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Hide past editions" }));
    expect(screen.queryByRole("button", { name: /15 Mar/ })).toBeNull();
  });
  it("opens a past edition with the past dates showing, and still offers sign-up for the next one", () => {
    sheet(race(["2026-03-15", "2027-03-14"]), "e-2026-03-15");
    expect(screen.getByRole("button", { name: /15 Mar/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /past edition/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Sign up on the official site/ })).toBeInTheDocument();
  });
});
