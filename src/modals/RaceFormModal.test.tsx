import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../telemetry", () => ({ track: vi.fn() }));
vi.mock("../notify", () => ({ notifyContribution: vi.fn() }));
vi.mock("../races", () => ({
  deleteRace: vi.fn().mockResolvedValue(undefined),
  findRaceDuplicates: vi.fn().mockResolvedValue([]),
  listKnownRaces: vi.fn().mockResolvedValue([]),
  duplicateRefusal: (e: { code?: string; details?: string; hint?: string }) =>
    e?.code === "RC409" ? { raceSlug: e.details, editionId: e.hint ?? null } : null,
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
import { deleteRace, findRaceDuplicates, listKnownRaces } from "../races";
import type { CatalogueRace } from "../types";

// The date bounds (a year back, two years ahead) read the clock; the prefill's date sits inside them.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-28T10:00:00"));
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(findRaceDuplicates).mockReset().mockResolvedValue([]);
  vi.mocked(listKnownRaces).mockReset().mockResolvedValue([]);
  vi.mocked(guessCountry).mockReturnValue(null);
  vi.mocked(reverseGeocode).mockResolvedValue(null);
  await setLocale("en", { persist: false });
});

function setup({ onCreated, onUseExisting }: { onCreated?: (id: string, existing?: boolean) => void; onUseExisting?: (race: CatalogueRace, editionId: string | null) => void } = {}) {
  const addRace = vi.fn().mockResolvedValue({ slug: "new-race", name: "New race" });
  const addEdition = vi.fn().mockResolvedValue({ id: "new-race-2027-05-08" });
  const onClose = vi.fn();
  const utils = render(<RaceFormModal addRace={addRace} addEdition={addEdition} onCreated={onCreated} onUseExisting={onUseExisting}
    showToast={vi.fn()} onClose={onClose} prefill={{ date: "2027-05-08", distanceKm: 21 }}/>);
  return { ...utils, addRace, addEdition, onClose };
}

const kili: CatalogueRace = { id: "kilimanjaro-international-marathon", slug: "kilimanjaro-international-marathon", name: "Kilimanjaro Marathon",
  city: "Moshi", country: "TZ", verified: true, distances: [42.2],
  editions: [{ id: "kilimanjaro-international-marathon-2027-02-07", date: "2027-02-07", distanceKm: 42.2, elevation: 500 }] };
const match = (strong: boolean, editionId: string | null = kili.editions[0].id) => ({ race: kili, strong, editionId });

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
    vi.mocked(findRaceDuplicates).mockResolvedValue([{ race: { id: "spartan-race", slug: "spartan-race", name: "Spartan Race Estérel", city: "Saint-Raphaël", country: "FR", editions: [] }, strong: false, editionId: null }]);
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
  it("lists an existing race the lookup finds, sending what's been typed so far", async () => {
    vi.mocked(findRaceDuplicates).mockResolvedValue([match(false, null)]);
    setup();
    typeName("KILIMANJARO INTERNATIONAL MARATHON");
    expect(await screen.findByText("Kilimanjaro Marathon")).toBeInTheDocument();
    expect(vi.mocked(findRaceDuplicates).mock.calls.at(-1)?.[0]).toMatchObject({
      name: "KILIMANJARO INTERNATIONAL MARATHON", date: "2027-05-08", distanceKm: 21 });
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

describe("RaceFormModal duplicate on submit", () => {
  const fillNew = () => {
    typeName("KILIMANJARO INTERNATIONAL MARATHON");
    pickCountry("tanz", "Tanzania");
  };
  const strongOnSubmit = (m: ReturnType<typeof match>) =>
    vi.mocked(findRaceDuplicates).mockImplementation(async q => q.name && q.country ? [m] : []);

  it("asks before creating a race that's already listed, and uses its race day", async () => {
    strongOnSubmit(match(true));
    const onCreated = vi.fn();
    const { addRace, onClose } = setup({ onCreated });
    fillNew();
    submit();
    expect(await screen.findByText("Is this your race?")).toBeInTheDocument();
    expect(addRace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, use this race" }));
    expect(onCreated).toHaveBeenCalledWith("kilimanjaro-international-marathon-2027-02-07", true);
    expect(onClose).toHaveBeenCalled();
  });

  it("opens the listed race through onUseExisting outside onboarding", async () => {
    strongOnSubmit(match(true));
    const onUseExisting = vi.fn();
    setup({ onUseExisting });
    fillNew();
    submit();
    fireEvent.click(await screen.findByRole("button", { name: "Yes, use this race" }));
    expect(onUseExisting).toHaveBeenCalledWith(kili, "kilimanjaro-international-marathon-2027-02-07");
  });

  it("adds the date to the listed race when its race day isn't there yet", async () => {
    strongOnSubmit(match(true, null));
    const { addRace, addEdition } = setup();
    fillNew();
    submit();
    fireEvent.click(await screen.findByRole("button", { name: "Yes, add my date to it" }));
    await waitFor(() => expect(addEdition).toHaveBeenCalledWith(expect.objectContaining({ raceSlug: kili.slug, date: "2027-05-08" })));
    expect(addRace).not.toHaveBeenCalled();
  });

  it("creates it anyway when the runner says it's a different race, without asking again", async () => {
    strongOnSubmit(match(true));
    const { addRace } = setup();
    fillNew();
    submit();
    fireEvent.click(await screen.findByRole("button", { name: "No, it's a different race" }));
    await waitFor(() => expect(addRace).toHaveBeenCalledTimes(1));
    expect(addRace.mock.calls[0][0]).toMatchObject({ distinctFrom: [kili.slug] });
    expect(screen.queryByText("Is this your race?")).not.toBeInTheDocument();
  });

  it("asks about each strong match in turn, skipping the ones already answered", async () => {
    const other: CatalogueRace = { ...kili, id: "kili-2", slug: "kili-2", name: "Kilimanjaro Half" };
    vi.mocked(findRaceDuplicates).mockImplementation(async q => q.name && q.country
      ? [match(true), { race: other, strong: true, editionId: null }] : []);
    const { addRace } = setup();
    fillNew();
    submit();
    fireEvent.click(await screen.findByRole("button", { name: "No, it's a different race" }));
    expect(await screen.findByText("Kilimanjaro Half")).toBeInTheDocument();
    expect(addRace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "No, it's a different race" }));
    await waitFor(() => expect(addRace).toHaveBeenCalledTimes(1));
    expect(addRace.mock.calls[0][0]).toMatchObject({ distinctFrom: [kili.slug, "kili-2"] });
  });

  it("never blocks a save when the lookup fails", async () => {
    vi.mocked(findRaceDuplicates).mockRejectedValue(new Error("offline"));
    const { addRace } = setup();
    fillNew();
    submit();
    await waitFor(() => expect(addRace).toHaveBeenCalledTimes(1));
  });

  it("turns the database's refusal into the same question, and each 'different' answer adds to the list", async () => {
    const other: CatalogueRace = { ...kili, id: "kili-2", slug: "kili-2", name: "Kilimanjaro Half" };
    // The refused race isn't in the ranked lookup at all: it's fetched by its edition.
    vi.mocked(findRaceDuplicates).mockImplementation(async q => q.name && q.country ? [match(true)] : []);
    vi.mocked(listKnownRaces).mockResolvedValue([other]);
    const { addRace, addEdition } = setup();
    addEdition.mockRejectedValueOnce({ code: "RC409", details: "kili-2", hint: "kili-2-2027-02-07" });
    fillNew();
    submit();
    fireEvent.click(await screen.findByRole("button", { name: "No, it's a different race" }));
    expect(await screen.findByText("This race is already listed for that day.")).toBeInTheDocument();
    expect(deleteRace).toHaveBeenCalledWith("new-race");
    expect(screen.getByText("Kilimanjaro Half")).toBeInTheDocument();
    expect(listKnownRaces).toHaveBeenCalledWith({ editionIds: ["kili-2-2027-02-07"] });
    fireEvent.click(screen.getByRole("button", { name: "No, it's a different race" }));
    await waitFor(() => expect(addRace).toHaveBeenCalledTimes(2));
    expect(addRace.mock.calls[1][0]).toMatchObject({ distinctFrom: [kili.slug, "kili-2"] });
  });
});

describe("RaceFormModal field checks", () => {
  const urlField = () => screen.getByLabelText("Official site (optional)") as HTMLInputElement;
  const fillNew = () => { typeName("Hackney Half"); pickCountry("united k", "United Kingdom"); };

  it("repairs a doubled scheme and shows where the link goes", async () => {
    const { addRace } = setup();
    fillNew();
    fireEvent.change(urlField(), { target: { value: "https://https//:Kilimanjarointernationalmarathon.com" } });
    expect(screen.getByText("Will link to kilimanjarointernationalmarathon.com")).toBeInTheDocument();
    submit();
    await waitFor(() => expect(addRace).toHaveBeenCalledWith(expect.objectContaining({ url: "https://kilimanjarointernationalmarathon.com/" })));
  });

  it("refuses an address with no real host, on the field", () => {
    const { addRace } = setup();
    fillNew();
    fireEvent.change(urlField(), { target: { value: "hackney half" } });
    submit();
    expect(urlField()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/doesn't look like a web address/)).toBeInTheDocument();
    expect(addRace).not.toHaveBeenCalled();
  });

  it("refuses a date more than two years ahead", () => {
    const { addRace } = setup();
    fillNew();
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2029-05-08" } });
    submit();
    expect(screen.getByText("Pick a date between a year ago and two years from now.")).toBeInTheDocument();
    expect(addRace).not.toHaveBeenCalled();
  });

  it("points out a country that disagrees with the pin, and fixes it in one tap", async () => {
    vi.mocked(reverseGeocode).mockResolvedValueOnce({ country: "TZ", city: "Moshi" });
    setup();
    pinOnMap();
    await waitFor(() => expect(countryField().value).toBe("Tanzania"));
    pickCountry("kenya", "Kenya");
    expect(screen.getByText("Your pin is in Tanzania.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use Tanzania" }));
    expect(countryField().value).toBe("Tanzania");
    expect(screen.queryByText("Your pin is in Tanzania.")).not.toBeInTheDocument();
  });

  it("forgets the old pin's country when a new pin can't be placed", async () => {
    vi.mocked(reverseGeocode).mockResolvedValueOnce({ country: "TZ", city: "Moshi" });
    setup();
    pinOnMap();
    await waitFor(() => expect(countryField().value).toBe("Tanzania"));
    vi.mocked(reverseGeocode).mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole("button", { name: /Change/ }));
    fireEvent.click(screen.getByRole("button", { name: "confirm pin" }));
    await waitFor(() => expect(vi.mocked(reverseGeocode)).toHaveBeenCalledTimes(2));
    pickCountry("kenya", "Kenya");
    expect(screen.queryByText(/Your pin is in/)).not.toBeInTheDocument();
  });

  it("warns, without blocking, on a climb that reads as an altitude", async () => {
    const { addRace } = setup();
    fillNew();
    fireEvent.change(screen.getByPlaceholderText("42.2"), { target: { value: "42.2" } });
    fireEvent.change(screen.getByLabelText("Elevation gain (m)"), { target: { value: "1500" } });
    expect(screen.getByText(/not the altitude/)).toBeInTheDocument();
    submit();
    await waitFor(() => expect(addRace).toHaveBeenCalledTimes(1));
  });
});
