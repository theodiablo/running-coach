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
  it("lists every country once, named and sorted in the locale", () => {
    const en = countryOptions("en");
    expect(en).toHaveLength(250);
    expect(en.every(o => o.name !== o.code)).toBe(true);
    expect(en.map(o => o.name)).toEqual([...en.map(o => o.name)].sort(new Intl.Collator("en").compare));
    expect(en.find(o => o.code === "TZ")?.name).toBe("Tanzania");
    expect(countryOptions("fr").find(o => o.code === "DE")?.name).toBe("Allemagne");
  });

  it("leaves out reserved codes", () => {
    const codes = countryOptions().map(o => o.code);
    for (const v of ["TA", "IC", "EU"]) expect(codes).not.toContain(v);
  });
});
