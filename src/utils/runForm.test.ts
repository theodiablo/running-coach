import { describe, it, expect } from "vitest";
import { hmsToSec, runFormComplete, runFormToPatch, runToForm } from "./runForm";
import type { Run } from "../types";

const run = {
  id: "r1", date: "2026-03-04", type: "TEMPO", km: 12.4, durationSec: 3725,
  hr: 152, hrMax: 178, elevation: 96, effort: 7, notes: "windy",
} as Run;

describe("runToForm / runFormToPatch", () => {
  it("round-trips a run through the form without drift", () => {
    expect(runFormToPatch(runToForm(run))).toMatchObject({
      date: "2026-03-04", type: "TEMPO", km: 12.4, durationSec: 3725,
      hr: 152, hrMax: 178, elevation: 96, effort: 7, notes: "windy",
    });
  });

  it("splits duration into h/m/s, leaving zero components blank", () => {
    expect(runToForm({ ...run, durationSec: 3725 })).toMatchObject({ dH: "1", dM: "2", dS: "5" });
    expect(runToForm({ ...run, durationSec: 1800 })).toMatchObject({ dH: "", dM: "30", dS: "" });
  });

  // Absent optional metrics must not come back as 0 — that would invent data.
  it("keeps unset optional metrics empty, and nulls them on the way out", () => {
    const f = runToForm({ ...run, hr: null, hrMax: null, elevation: undefined } as Run);
    expect(f).toMatchObject({ hr: "", hrMax: "", elev: "" });
    expect(runFormToPatch(f)).toMatchObject({ hr: null, hrMax: null, elevation: undefined });
  });
});

describe("hmsToSec", () => {
  it("sums the three components, treating blanks as zero", () => {
    expect(hmsToSec({ dH: "1", dM: "2", dS: "5" })).toBe(3725);
    expect(hmsToSec({ dH: "", dM: "45", dS: "" })).toBe(2700);
    expect(hmsToSec({ dH: "", dM: "", dS: "" })).toBe(0);
  });
});

describe("runFormComplete", () => {
  it("needs a distance and some duration", () => {
    const base = runToForm(run);
    expect(runFormComplete(base)).toBe(true);
    expect(runFormComplete({ ...base, km: "" })).toBe(false);
    // Seconds alone is not a duration — matches what both forms rejected before.
    expect(runFormComplete({ ...base, dH: "", dM: "", dS: "30" })).toBe(false);
    expect(runFormComplete({ ...base, dH: "1", dM: "" })).toBe(true);
  });

  // An indoor bike/elliptical has no distance comparable to running, so
  // demanding one is what made those sessions unloggable (docs/indoor-sessions.md).
  it("lets cross-training save on duration alone", () => {
    const cross = { ...runToForm(run), type: "OTHER", km: "" };
    expect(runFormComplete(cross)).toBe(true);
    expect(runFormComplete({ ...cross, dH: "", dM: "", dS: "" })).toBe(false);
  });
});

describe("cross-training activity", () => {
  it("round-trips the machine on an OTHER run", () => {
    const cross = { ...run, type: "OTHER", km: 0, activity: "bike" } as Run;
    const f = runToForm(cross);
    expect(f.activity).toBe("bike");
    expect(runFormToPatch(f)).toMatchObject({ type: "OTHER", km: 0, activity: "bike" });
  });

  it("drops the machine when the type moves off OTHER", () => {
    const f = { ...runToForm(run), type: "EASY", activity: "bike" };
    expect(runFormToPatch(f).activity).toBeUndefined();
  });

  // parseFloat("") is NaN, which would reach the store as a broken distance.
  it("coerces a blank distance to 0 rather than NaN", () => {
    const f = { ...runToForm(run), type: "OTHER", km: "" };
    expect(runFormToPatch(f).km).toBe(0);
  });
});
