import { describe, it, expect } from "vitest";
// The FIT-export endpoint calibration is server-side (suunto-import runs the
// ladder), but the ordering and the "is this really a FIT?" check are pure —
// and they're what stands between a working import and the silent
// summary-only degradation that shipped, so they're tested here.
import { FIT_VARIANTS, fitVariantAuth, fitVariantPath, fitVariantsToTry, looksLikeFit }
  // @ts-expect-error — plain ESM module shared with the Supabase edge function.
  from "../../supabase/functions/_shared/suunto/fitExport.mjs";

type Variant = { id: string };

const fitBytes = (sig = ".FIT") => {
  const b = new Uint8Array(20);
  for (let i = 0; i < 4; i++) b[8 + i] = sig.charCodeAt(i);
  return b;
};

describe("suunto FIT export variants", () => {
  it("varies both the path and the auth style", () => {
    const urls = FIT_VARIANTS.map((v: Variant) => `${fitVariantPath(v, "abc")} | ${fitVariantAuth(v, "tok")}`);
    expect(urls).toEqual([
      "/v2/workout/exportFit/abc | Bearer tok",
      "/v2/workouts/exportFit/abc | Bearer tok",
      "/v2/workout/exportFit/abc | tok",
      "/v2/workouts/exportFit/abc | tok",
    ]);
  });

  it("escapes the workout key", () => {
    expect(fitVariantPath(FIT_VARIANTS[0], "a/b?c")).toBe("/v2/workout/exportFit/a%2Fb%3Fc");
  });

  it("tries every candidate before calibration, in most-likely-first order", () => {
    expect(fitVariantsToTry("").map((v: Variant) => v.id)).toEqual(FIT_VARIANTS.map((v: Variant) => v.id));
    expect(fitVariantsToTry("nonsense").map((v: Variant) => v.id)).toEqual(FIT_VARIANTS.map((v: Variant) => v.id));
  });

  it("puts a calibrated variant first, keeping the rest as the net", () => {
    const order = fitVariantsToTry("workouts-raw").map((v: Variant) => v.id);
    expect(order[0]).toBe("workouts-raw");
    expect([...order].sort()).toEqual(FIT_VARIANTS.map((v: Variant) => v.id).sort());
  });

  it("only accepts a body that really is a FIT", () => {
    // A 2xx alone must never calibrate the endpoint: an APIM notice or a JSON
    // error page would be remembered as the export path forever.
    expect(looksLikeFit(fitBytes())).toBe(true);
    expect(looksLikeFit(fitBytes("JSON"))).toBe(false);
    expect(looksLikeFit(new Uint8Array(4))).toBe(false);
    expect(looksLikeFit(null)).toBe(false);
  });
});
