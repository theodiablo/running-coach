import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../telemetry", () => ({ track: vi.fn() }));
vi.mock("../notify", () => ({ notifyContribution: vi.fn() }));
vi.mock("../races", () => ({
  deleteRace: vi.fn().mockResolvedValue(undefined),
  peekRaceSearch: () => null,
  raceSearchVersion: () => 0,
  searchRaces: vi.fn().mockResolvedValue({ races: [], next: null, total: 0 }),
}));
vi.mock("../components/LocationPicker", () => ({
  LocationPicker: ({ onConfirm }: { onConfirm: (p: { lat: number; lng: number }) => void }) =>
    <button onClick={() => onConfirm({ lat: -3.35, lng: 37.34 })}>confirm pin</button>,
}));
vi.mock("../utils/geocode", () => ({ reverseGeocode: vi.fn(async () => null) }));
vi.mock("../utils/guessCountry", () => ({ guessCountry: vi.fn(() => null) }));

import { setLocale } from "../i18n";
import { guessCountry } from "../utils/guessCountry";
import { reverseGeocode } from "../utils/geocode";
import { RaceFormModal } from "./RaceFormModal";

afterEach(async () => {
  cleanup();
  vi.mocked(guessCountry).mockReturnValue(null);
  vi.mocked(reverseGeocode).mockResolvedValue(null);
  await setLocale("en", { persist: false });
});

function setup() {
  const addRace = vi.fn().mockResolvedValue({ slug: "new-race", name: "New race" });
  const addEdition = vi.fn().mockResolvedValue({ id: "new-race-2027-05-08" });
  const utils = render(<RaceFormModal addRace={addRace} addEdition={addEdition}
    showToast={vi.fn()} onClose={vi.fn()} prefill={{ date: "2027-05-08", distanceKm: 21 }}/>);
  return { ...utils, addRace, addEdition };
}

const typeName = (v: string) => fireEvent.change(screen.getByPlaceholderText("e.g. Lyon Marathon"), { target: { value: v } });
const countryField = (name: RegExp = /Country/) => screen.getByRole("combobox", { name }) as HTMLInputElement;
const typeCountry = (v: string, name?: RegExp) => {
  fireEvent.focus(countryField(name));
  fireEvent.change(countryField(name), { target: { value: v } });
};
const optionNames = () => screen.queryAllByRole("option").map(o => o.textContent);
const pickCountry = (query: string, name: string) => {
  typeCountry(query);
  fireEvent.click(screen.getByRole("option", { name }));
};
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Add race" }));

describe("RaceFormModal country", () => {
  it("refuses a new race without a country", () => {
    const { addRace } = setup();
    typeName("Spartan Race Carcassonne");
    submit();
    expect(screen.getByText(/Choose a country\./)).toBeInTheDocument();
    expect(addRace).not.toHaveBeenCalled();
  });

  it("filters the list as the runner types, ignoring accents", () => {
    setup();
    typeCountry("tanz");
    expect(optionNames()).toEqual(["Tanzania"]);
    typeCountry("cote");
    expect(optionNames()).toContain("Côte d’Ivoire");
  });

  it("offers real countries only", () => {
    setup();
    typeCountry("tristan");
    expect(optionNames()).toEqual([]);
    expect(screen.getByText("No country matches")).toBeInTheDocument();
  });

  it("saves the picked country's code and shows its name", async () => {
    const { addRace } = setup();
    typeName("Hackney Half");
    pickCountry("united k", "United Kingdom");
    expect(countryField().value).toBe("United Kingdom");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    submit();
    await waitFor(() => expect(addRace).toHaveBeenCalledTimes(1));
    expect(addRace.mock.calls[0][0]).toMatchObject({ name: "Hackney Half", country: "GB" });
  });

  it("picks with the keyboard", async () => {
    const { addRace } = setup();
    typeName("Kilimanjaro Marathon");
    typeCountry("tanz");
    fireEvent.keyDown(countryField(), { key: "Enter" });
    expect(countryField().value).toBe("Tanzania");
    submit();
    await waitFor(() => expect(addRace).toHaveBeenCalledWith(expect.objectContaining({ country: "TZ" })));
  });

  it("reopens the list after a pick, by tap or arrow key, keeping the country", () => {
    setup();
    pickCountry("tanz", "Tanzania");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.click(countryField());
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Tanzania" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(countryField(), { key: "Enter" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.keyDown(countryField(), { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(countryField().value).toBe("Tanzania");
  });

  it("keeps the previous country when the runner leaves without picking", () => {
    vi.mocked(guessCountry).mockReturnValue("FR");
    setup();
    typeCountry("ger");
    fireEvent.blur(countryField());
    expect(countryField().value).toBe("France");
  });

  it("preselects the country the device is in", async () => {
    vi.mocked(guessCountry).mockReturnValue("FR");
    const { addRace } = setup();
    typeName("Trail des Crêtes");
    expect(countryField().value).toBe("France");
    submit();
    await waitFor(() => expect(addRace).toHaveBeenCalledWith(expect.objectContaining({ country: "FR" })));
  });

  it.each([
    ["fr", /Pays/, "Tape pour chercher", "allem", "Allemagne"],
    ["es", /País/, "Escribe para buscar", "alem", "Alemania"],
  ])("names and searches the countries in %s", async (lang, label, placeholder, query, germany) => {
    await setLocale(lang as "fr" | "es", { persist: false });
    setup();
    expect(countryField(label)).toHaveAttribute("placeholder", placeholder);
    typeCountry(query, label);
    expect(optionNames()).toEqual([germany]);
    typeCountry("germany", label);
    expect(optionNames()).toEqual([germany]);
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

const cityField = () => screen.getByRole("textbox", { name: "City" }) as HTMLInputElement;
const pinOnMap = () => {
  fireEvent.click(screen.getByRole("button", { name: /Set location on map/ }));
  fireEvent.click(screen.getByRole("button", { name: "confirm pin" }));
};

describe("RaceFormModal location first", () => {
  it("asks for the location before the country and city", () => {
    setup();
    const order = ["Set location on map", "Country", "City"].map(name =>
      name === "Set location on map" ? screen.getByRole("button", { name: /Set location on map/ }) : screen.getByLabelText(name));
    for (let i = 1; i < order.length; i++) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("fills the country and city from the picked point", async () => {
    vi.mocked(guessCountry).mockReturnValue("FR");
    vi.mocked(reverseGeocode).mockResolvedValue({ country: "TZ", city: "Moshi" });
    const { addRace } = setup();
    typeName("Kilimanjaro Marathon");
    pinOnMap();
    await waitFor(() => expect(countryField().value).toBe("Tanzania"));
    expect(cityField().value).toBe("Moshi");
    expect(vi.mocked(reverseGeocode)).toHaveBeenCalledWith({ lat: -3.35, lng: 37.34 });
    submit();
    await waitFor(() => expect(addRace).toHaveBeenCalledWith(expect.objectContaining({ country: "TZ", city: "Moshi", lat: -3.35, lng: 37.34 })));
  });

  it("never overwrites a city the runner typed, but replaces one it filled", async () => {
    vi.mocked(reverseGeocode).mockResolvedValueOnce({ country: "TZ", city: "Moshi" });
    setup();
    pinOnMap();
    await waitFor(() => expect(cityField().value).toBe("Moshi"));
    vi.mocked(reverseGeocode).mockResolvedValueOnce({ country: "TZ", city: "Arusha" });
    fireEvent.click(screen.getByRole("button", { name: /Change/ }));
    fireEvent.click(screen.getByRole("button", { name: "confirm pin" }));
    await waitFor(() => expect(cityField().value).toBe("Arusha"));
    fireEvent.change(cityField(), { target: { value: "Moshi town" } });
    vi.mocked(reverseGeocode).mockResolvedValueOnce({ country: "KE", city: "Nairobi" });
    fireEvent.click(screen.getByRole("button", { name: /Change/ }));
    fireEvent.click(screen.getByRole("button", { name: "confirm pin" }));
    await waitFor(() => expect(countryField().value).toBe("Kenya"));
    expect(cityField().value).toBe("Moshi town");
  });

  it("keeps a city the runner retyped to match the one the map filled", async () => {
    vi.mocked(reverseGeocode).mockResolvedValueOnce({ country: "TZ", city: "Moshi" });
    setup();
    pinOnMap();
    await waitFor(() => expect(cityField().value).toBe("Moshi"));
    fireEvent.change(cityField(), { target: { value: "" } });
    fireEvent.change(cityField(), { target: { value: "Moshi" } });
    vi.mocked(reverseGeocode).mockResolvedValueOnce({ country: "TZ", city: "Arusha" });
    fireEvent.click(screen.getByRole("button", { name: /Change/ }));
    fireEvent.click(screen.getByRole("button", { name: "confirm pin" }));
    await waitFor(() => expect(vi.mocked(reverseGeocode)).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add race" })).toBeEnabled());
    expect(cityField().value).toBe("Moshi");
  });

  it("holds the submit until the pin's place is known, so a guessed country can't be saved", async () => {
    vi.mocked(guessCountry).mockReturnValue("FR");
    let resolve!: (v: { country: string; city: string }) => void;
    vi.mocked(reverseGeocode).mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const { addRace } = setup();
    typeName("Kilimanjaro Marathon");
    pinOnMap();
    expect(screen.getByRole("button", { name: "Add race" })).toBeDisabled();
    submit();
    expect(addRace).not.toHaveBeenCalled();
    resolve({ country: "TZ", city: "Moshi" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Add race" })).toBeEnabled());
    submit();
    await waitFor(() => expect(addRace).toHaveBeenCalledWith(expect.objectContaining({ country: "TZ" })));
  });

  it("leaves the fields alone when the place can't be found", async () => {
    vi.mocked(guessCountry).mockReturnValue("FR");
    setup();
    fireEvent.change(cityField(), { target: { value: "Lyon" } });
    pinOnMap();
    await waitFor(() => expect(vi.mocked(reverseGeocode)).toHaveBeenCalled());
    expect(countryField().value).toBe("France");
    expect(cityField().value).toBe("Lyon");
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
    pickCountry("fra", "France");
    fireEvent.click(screen.getByRole("button", { name: "Trail" }));
    submit();
    await waitFor(() => expect(addRace).toHaveBeenCalledWith(expect.objectContaining({ terrain: "trail" })));
  });
});
