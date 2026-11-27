import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../constants", () => ({ MAP_KEY: "test-key" }));

import { parseGeocodeResult, parseReverseResult, reverseGeocode, REVERSE_GEOCODE_TIMEOUT_MS } from "./geocode";

describe("parseGeocodeResult", () => {
  it("reads [lng, lat] center off the first feature", () => {
    const json = { features: [{ center: [4.835, 45.764] }] };
    expect(parseGeocodeResult(json)).toEqual({ lat: 45.764, lng: 4.835 });
  });

  it("returns null when there are no features", () => {
    expect(parseGeocodeResult({ features: [] })).toBeNull();
    expect(parseGeocodeResult({})).toBeNull();
    expect(parseGeocodeResult(null)).toBeNull();
  });

  it("returns null when center is missing or malformed", () => {
    expect(parseGeocodeResult({ features: [{}] })).toBeNull();
    expect(parseGeocodeResult({ features: [{ center: [4.835] }] })).toBeNull();
    expect(parseGeocodeResult({ features: [{ center: ["a", "b"] }] })).toBeNull();
  });
});

describe("parseReverseResult", () => {
  it("reads the city and country off a municipality feature", () => {
    const json = { features: [{ id: "municipality.1", text: "Moshi", place_type: ["municipality"],
      properties: { country_code: "tz" }, context: [{ id: "country.2", text: "Tanzania", country_code: "tz" }] }] };
    expect(parseReverseResult(json)).toEqual({ country: "TZ", city: "Moshi" });
  });

  it("finds the town in the context when the point lands on a street", () => {
    const json = { features: [{ id: "road.9", text: "Rue de la Paix", place_type: ["road"], properties: {},
      context: [
        { id: "municipal_district.3", text: "2e Arrondissement" },
        { id: "municipality.4", text: "Paris", country_code: "fr" },
        { id: "country.5", text: "France", country_code: "fr" },
      ] }] };
    expect(parseReverseResult(json)).toEqual({ country: "FR", city: "Paris" });
  });

  it("keeps the country when no town is found, and refuses a code that isn't a country", () => {
    expect(parseReverseResult({ features: [{ place_type: ["region"], text: "Somewhere", properties: { country_code: "es" } }] }))
      .toEqual({ country: "ES", city: null });
    expect(parseReverseResult({ features: [{ id: "municipality.1", text: "Edinburgh of the Seven Seas", properties: { country_code: "ta" } }] }))
      .toEqual({ country: null, city: "Edinburgh of the Seven Seas" });
  });

  it("returns null for an empty or malformed response", () => {
    for (const json of [null, {}, { features: [] }, { features: ["x"] }, { features: [{}] }]) expect(parseReverseResult(json)).toBeNull();
  });
});

describe("reverseGeocode", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });
  const moshi = { features: [{ id: "municipality.1", text: "Moshi", place_type: ["municipality"], properties: { country_code: "tz" } }] };

  it("works where AbortSignal.timeout doesn't exist (iOS 15)", async () => {
    vi.stubGlobal("AbortSignal", Object.assign(function () {}, { timeout: undefined }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(moshi))));
    await expect(reverseGeocode({ lat: -3.35, lng: 37.34 })).resolves.toEqual({ country: "TZ", city: "Moshi" });
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain("/geocoding/37.34,-3.35.json?key=test-key");
  });

  it("gives up after the timeout so the form is never held", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })));
    const pending = reverseGeocode({ lat: 0, lng: 0 });
    await vi.advanceTimersByTimeAsync(REVERSE_GEOCODE_TIMEOUT_MS);
    await expect(pending).resolves.toBeNull();
  });
});
