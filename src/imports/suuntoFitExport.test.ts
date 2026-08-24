import { describe, it, expect } from "vitest";
// The FIT download itself is server-side (suunto-import), but the export path
// and the "is this really a FIT?" check are pure — and they're what stands
// between a working import and the silent summary-only degradation that
// shipped, so they're tested here.
import { fitPath, looksLikeFit }
  // @ts-expect-error — plain ESM module shared with the Supabase edge function.
  from "../../supabase/functions/_shared/suunto/fitExport.mjs";

const fitBytes = (sig = ".FIT") => {
  const b = new Uint8Array(20);
  for (let i = 0; i < 4; i++) b[8 + i] = sig.charCodeAt(i);
  return b;
};

describe("suunto FIT export", () => {
  it("uses the documented v3 export route", () => {
    // A different API version and path shape from the workout listing —
    // extrapolating one from the other is what produced the 401 that degraded
    // every import to summary-only.
    expect(fitPath("abc")).toBe("/v3/workouts/abc/fit");
  });

  it("escapes the workout key", () => {
    expect(fitPath("a/b?c")).toBe("/v3/workouts/a%2Fb%3Fc/fit");
  });

  it("only accepts a body that really is a FIT", () => {
    // A 2xx alone means nothing: an APIM notice or a JSON error page arrives
    // as 200 too, and importing one as a trace is worse than no trace.
    expect(looksLikeFit(fitBytes())).toBe(true);
    expect(looksLikeFit(fitBytes("JSON"))).toBe(false);
    expect(looksLikeFit(new Uint8Array(4))).toBe(false);
    expect(looksLikeFit(null)).toBe(false);
  });
});
