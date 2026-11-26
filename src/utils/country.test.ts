import { describe, it, expect } from "vitest";
import { countryCode, countryName, countryOptions } from "./country";

describe("countryCode", () => {
  it("accepts ISO alpha-2 codes in any case, trimmed", () => {
    expect(countryCode("FR")).toBe("FR");
    expect(countryCode(" es ")).toBe("ES");
    expect(countryCode("Us")).toBe("US");
  });

  it("maps UK to GB", () => {
    expect(countryCode("uk")).toBe("GB");
  });

  it("rejects empty, malformed and unassigned codes", () => {
    for (const v of ["", null, undefined, "F", "FRA", "F1", "XX", "QQ"]) expect(countryCode(v)).toBeNull();
  });

  it("rejects codes that aren't a country", () => {
    for (const v of ["EU", "UN", "ZZ", "TA", "IC", "AC", "FX", "SU"]) expect(countryCode(v)).toBeNull();
  });
});

describe("countryName", () => {
  it("names the country in the requested locale", () => {
    expect(countryName("FR", "en")).toBe("France");
    expect(countryName("DE", "fr")).toBe("Allemagne");
  });
});

describe("countryOptions", () => {
  it.each([
    ["en", { DE: "Germany", GB: "United Kingdom", TZ: "Tanzania", ES: "Spain" }],
    ["fr", { DE: "Allemagne", GB: "Royaume-Uni", TZ: "Tanzanie", ES: "Espagne" }],
    ["es", { DE: "Alemania", GB: "Reino Unido", TZ: "Tanzania", ES: "España" }],
  ])("lists every country once, named and sorted in %s", (locale, spot) => {
    const options = countryOptions(locale);
    const names = options.map(o => o.name);
    expect(options).toHaveLength(250);
    expect(options.every(o => o.name !== o.code)).toBe(true);
    expect(names).toEqual([...names].sort(new Intl.Collator(locale).compare));
    for (const [code, name] of Object.entries(spot)) expect(options.find(o => o.code === code)?.name).toBe(name);
  });

  it("leaves out reserved codes", () => {
    const codes = countryOptions().map(o => o.code);
    for (const v of ["TA", "IC", "EU"]) expect(codes).not.toContain(v);
  });
});
