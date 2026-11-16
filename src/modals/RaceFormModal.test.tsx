import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../telemetry", () => ({ track: vi.fn() }));
vi.mock("../notify", () => ({ notifyContribution: vi.fn() }));
vi.mock("../races", () => ({
  deleteRace: vi.fn().mockResolvedValue(undefined),
  searchRaces: vi.fn().mockResolvedValue({ races: [], next: null, total: 0 }),
}));
vi.mock("../components/LocationPicker", () => ({ LocationPicker: () => null }));

import { RaceFormModal } from "./RaceFormModal";

afterEach(cleanup);

function setup() {
  const addRace = vi.fn().mockResolvedValue({ slug: "new-race", name: "New race" });
  const addEdition = vi.fn().mockResolvedValue({ id: "new-race-2027-05-08" });
  const utils = render(<RaceFormModal addRace={addRace} addEdition={addEdition}
    showToast={vi.fn()} onClose={vi.fn()} prefill={{ date: "2027-05-08", distanceKm: 21 }}/>);
  return { ...utils, addRace, addEdition };
}

const typeName = (v: string) => fireEvent.change(screen.getByPlaceholderText("e.g. Lyon Marathon"), { target: { value: v } });
const typeCountry = (v: string) => fireEvent.change(screen.getByPlaceholderText("FR"), { target: { value: v } });
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Add race" }));

describe("RaceFormModal country", () => {
  it("refuses a new race without a country", () => {
    const { addRace } = setup();
    typeName("Spartan Race Carcassonne");
    submit();
    expect(screen.getByText(/A country is required/)).toBeInTheDocument();
    expect(addRace).not.toHaveBeenCalled();
  });

  it("refuses a code that isn't a country", () => {
    const { addRace } = setup();
    typeName("Spartan Race Carcassonne");
    typeCountry("XX");
    submit();
    expect(screen.getByText(/A country is required/)).toBeInTheDocument();
    expect(addRace).not.toHaveBeenCalled();
  });

  it("names the typed country and saves its normalised code", async () => {
    const { addRace } = setup();
    typeName("Hackney Half");
    typeCountry("uk");
    expect(screen.getByText("United Kingdom")).toBeInTheDocument();
    submit();
    await waitFor(() => expect(addRace).toHaveBeenCalledTimes(1));
    expect(addRace.mock.calls[0][0]).toMatchObject({ name: "Hackney Half", country: "GB" });
  });

  it("doesn't ask for a country when adding a date to an existing race", async () => {
    const { searchRaces } = await import("../races");
    vi.mocked(searchRaces).mockResolvedValueOnce({ races: [{ id: "spartan-race", slug: "spartan-race", name: "Spartan Race Estérel", city: "Saint-Raphaël", country: "FR", editions: [] }], next: null, total: 1 });
    const { addRace, addEdition } = setup();
    typeName("Spartan");
    fireEvent.click(await screen.findByText("Spartan Race Estérel"));
    submit();
    await waitFor(() => expect(addEdition).toHaveBeenCalledTimes(1));
    expect(addEdition.mock.calls[0][0]).toMatchObject({ raceSlug: "spartan-race", date: "2027-05-08", distanceKm: 21 });
    expect(addRace).not.toHaveBeenCalled();
  });
});

describe("RaceFormModal duplicates and terrain", () => {
  it("offers an existing race found by the server search", async () => {
    const { searchRaces } = await import("../races");
    vi.mocked(searchRaces).mockResolvedValueOnce({ races: [{ id: "lyon", slug: "lyon", name: "Lyon Marathon", city: "Lyon", country: "FR", editions: [] }], next: null, total: 1 });
    setup();
    typeName("Lyon");
    expect(await screen.findByText("Lyon Marathon")).toBeInTheDocument();
    expect(vi.mocked(searchRaces).mock.calls.at(-1)?.[0]).toMatchObject({ query: "Lyon", limit: 5 });
  });

  it("saves the terrain picked for a new race", async () => {
    const { addRace } = setup();
    typeName("Trail des Crêtes");
    typeCountry("FR");
    fireEvent.click(screen.getByRole("radio", { name: "Trail" }));
    submit();
    await waitFor(() => expect(addRace).toHaveBeenCalledWith(expect.objectContaining({ terrain: "trail" })));
  });
});
