import { describe, it, expect } from "vitest";
import { countryCode, countryName, countryOptions, filterCountries } from "./country";

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

describe("filterCountries", () => {
  const en = countryOptions("en");
  const names = (q: string, opts = en) => filterCountries(opts, q).map(o => o.name);

  it("returns everything for an empty query", () => {
    expect(filterCountries(en, "  ")).toHaveLength(250);
  });

  it("puts names starting with the query before names with a word starting with it", () => {
    const guinea = names("guinea");
    expect(guinea.slice(0, 2)).toEqual(["Guinea", "Guinea-Bissau"]);
    expect(guinea).toEqual(expect.arrayContaining(["Equatorial Guinea", "Papua New Guinea"]));
  });

  it("ignores case and accents", () => {
    expect(names("COTE")).toContain("Côte d’Ivoire");
    expect(names("reunion")).toContain("Réunion");
  });

  it("matches codes and common aliases first", () => {
    expect(names("uk")[0]).toBe("United Kingdom");
    expect(names("usa")[0]).toBe("United States");
    expect(names("tz")[0]).toBe("Tanzania");
  });

  it("finds a country by its English name in another language", () => {
    expect(names("spain", countryOptions("fr"))).toEqual(["Espagne"]);
  });
});
