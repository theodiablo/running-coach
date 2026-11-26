import { describe, it, expect } from "vitest";
import { countryForTimeZone, guessCountry } from "./guessCountry";

describe("countryForTimeZone", () => {
  it("maps zones and their legacy aliases to the country", () => {
    expect(countryForTimeZone("Europe/Paris")).toBe("FR");
    expect(countryForTimeZone("Africa/Dar_es_Salaam")).toBe("TZ");
    expect(countryForTimeZone("Asia/Kolkata")).toBe("IN");
    expect(countryForTimeZone("Asia/Calcutta")).toBe("IN");
    expect(countryForTimeZone("America/Denver")).toBe("US");
  });

  it("has no country for UTC or an unknown zone", () => {
    for (const z of ["UTC", "Etc/UTC", "Etc/GMT+2", "Mars/Olympus", undefined]) expect(countryForTimeZone(z)).toBeNull();
  });
});

describe("guessCountry", () => {
  it("trusts the time zone over the language", () => {
    expect(guessCountry({ timeZone: "Europe/Madrid", languages: ["en-US"] })).toBe("ES");
  });

  it("falls back to the first language with a region", () => {
    expect(guessCountry({ timeZone: "UTC", languages: ["fr", "fr-BE", "en-GB"] })).toBe("BE");
  });

  it("guesses nothing without a usable signal", () => {
    expect(guessCountry({ timeZone: "UTC", languages: ["en", "fr"] })).toBeNull();
    expect(guessCountry({ timeZone: undefined, languages: ["es-419"] })).toBeNull();
    expect(guessCountry({})).toBeNull();
  });
});
