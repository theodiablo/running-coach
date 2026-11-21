import { describe, it, expect } from "vitest";
import { editionChoices } from "./raceEditions";

const ed = (id: string, date: string) => ({ id, date, distanceKm: 42.2 });
const TODAY = "2026-11-21";
const last = ed("bcn-2026", "2026-03-15");
const next = ed("bcn-2027", "2027-03-14");

describe("editionChoices", () => {
  it("hides a past edition beside the next one until asked", () => {
    const c = editionChoices([last, next], TODAY, "bcn-2027", false);
    expect(c.chips).toEqual([]);
    expect(c.pastCount).toBe(1);
    expect(c.canTogglePast).toBe(true);
  });
  it("shows past editions after upcoming ones on request", () => {
    expect(editionChoices([last, next], TODAY, "bcn-2027", true).chips.map(e => e.id)).toEqual(["bcn-2027", "bcn-2026"]);
  });
  it("offers several upcoming editions without the past", () => {
    const half = { ...ed("bcn-10k-2027", "2027-03-13"), distanceKm: 10 };
    expect(editionChoices([last, next, half], TODAY, "bcn-2027", false).chips.map(e => e.id)).toEqual(["bcn-10k-2027", "bcn-2027"]);
  });
  it("keeps past editions open when the open edition is past", () => {
    const c = editionChoices([last, next], TODAY, "bcn-2026", false);
    expect(c.chips.map(e => e.id)).toEqual(["bcn-2027", "bcn-2026"]);
    expect(c.canTogglePast).toBe(false);
  });
  it("lists past editions when nothing is upcoming", () => {
    const older = ed("bcn-2025", "2025-03-16");
    expect(editionChoices([older, last], TODAY, "bcn-2026", false).chips.map(e => e.id)).toEqual(["bcn-2026", "bcn-2025"]);
  });
  it("counts today's race as upcoming", () => {
    expect(editionChoices([ed("a", TODAY), last], TODAY, "a", false).canTogglePast).toBe(true);
  });
});
