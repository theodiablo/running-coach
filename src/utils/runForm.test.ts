import { describe, it, expect } from "vitest";
import { hmsToSec, runFormComplete, runFormErrors, runFormHasDetail, runFormToPatch, runToForm } from "./runForm";
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

  // The form offers no distance field for cross-training, but a distance typed
  // before the type was switched is still in state. Letting it out would put a
  // bike's kilometres into weekly volume, badges and the plan's fitness signal.
  it("drops a leftover distance when the type is OTHER", () => {
    const f = { ...runToForm(run), type: "OTHER", km: "25" };
    expect(runFormToPatch(f).km).toBe(0);
  });
});

describe("runFormErrors", () => {
  it("blames the field that is actually missing", () => {
    const base = runToForm(run);
    expect(runFormErrors(base)).toEqual({ km: false, duration: false });
    expect(runFormErrors({ ...base, km: "" })).toEqual({ km: true, duration: false });
    // Every box visibly filled, yet incomplete — the old single banner ("distance
    // and duration are required") gave no clue which rule this broke.
    expect(runFormErrors({ ...base, dH: "", dM: "", dS: "30" })).toEqual({ km: false, duration: true });
  });

  it("never asks cross-training for a distance", () => {
    expect(runFormErrors({ ...runToForm(run), type: "OTHER", km: "" }).km).toBe(false);
  });
});

describe("perceived effort", () => {
  // It used to default to 5 and always save, so a run logged without touching
  // the slider was indistinguishable from one deliberately rated 5 — including
  // to the coach, which reads the field.
  it("saves nothing when the runner did not say", () => {
    expect(runFormToPatch({ ...runToForm(run), effort: 0 }).effort).toBeNull();
    expect(runFormToPatch({ ...runToForm(run), effort: 7 }).effort).toBe(7);
  });

  it("reads an unset effort back as unset", () => {
    expect(runToForm({ ...run, effort: null } as Run).effort).toBe(0);
  });
});

describe("runFormHasDetail", () => {
  it("is true only when there is optional detail worth showing", () => {
    const bare = { ...runToForm(run), hr: "", hrMax: "", elev: "", notes: "", effort: 0 };
    expect(runFormHasDetail(bare)).toBe(false);
    expect(runFormHasDetail({ ...bare, hr: "150" })).toBe(true);
    expect(runFormHasDetail({ ...bare, notes: "windy" })).toBe(true);
    expect(runFormHasDetail({ ...bare, effort: 6 })).toBe(true);
  });
});
