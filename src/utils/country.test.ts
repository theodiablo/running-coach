import { describe, it, expect } from "vitest";
import { countryCode, countryName } from "./country";

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
    for (const v of ["EU", "UN", "ZZ"]) expect(countryCode(v)).toBeNull();
  });
});

describe("countryName", () => {
  it("names the country in the requested locale", () => {
    expect(countryName("FR", "en")).toBe("France");
    expect(countryName("DE", "fr")).toBe("Allemagne");
  });
});
