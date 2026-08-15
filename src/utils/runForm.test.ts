import { describe, it, expect } from "vitest";
import { canonicalDur, durToSec, formatDur, hmsToSec, normalizeDur, runFormComplete, runFormErrors, runFormHasDetail, runFormToPatch, runToForm, secToDur, setRunField } from "./runForm";
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

  it("loads the duration as the digits you would have typed", () => {
    expect(runToForm({ ...run, durationSec: 3725 })).toMatchObject({ dur: "10205" });
    expect(runToForm({ ...run, durationSec: 1800 })).toMatchObject({ dur: "3000" });
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

// The masked duration field: digits fill from the right, so a time is typed in
// the order a watch face or a race result is already written in.
describe("duration digits", () => {
  it("groups digits the way they will be read back", () => {
    expect(formatDur("")).toBe("");
    expect(formatDur("4")).toBe("0:04");
    expect(formatDur("43")).toBe("0:43");
    expect(formatDur("430")).toBe("4:30");
    expect(formatDur("4300")).toBe("43:00");
    expect(formatDur("15207")).toBe("1:52:07");
  });

  it("parses every prefix, so nothing typed is ever invalid", () => {
    expect(durToSec("")).toBe(0);
    expect(durToSec("43")).toBe(43);
    expect(durToSec("4300")).toBe(43 * 60);
    expect(durToSec("15207")).toBe(3600 + 52 * 60 + 7);
  });

  it("round-trips seconds through the digit string", () => {
    for (const sec of [0, 7, 59, 60, 630, 2580, 3725, 6727, 35999]) {
      expect(durToSec(secToDur(sec))).toBe(sec);
    }
  });

  it("keeps only the last six digits, so a stuck key can't overflow the field", () => {
    expect(normalizeDur("123456789")).toBe("456789");
    expect(durToSec("123456789")).toBe(45 * 3600 + 67 * 60 + 89);
  });

  it("strips leading zeros and anything that isn't a digit", () => {
    expect(normalizeDur("00430")).toBe("430");
    expect(normalizeDur("4:30")).toBe("430");
    expect(normalizeDur("abc")).toBe("");
  });

  // The field must never show a value it won't save. Raw digits can express
  // 0:75 or 23:45:67; seconds cannot, so input is settled through them.
  it("never displays a duration different from the one it saves", () => {
    for (const raw of ["75", "0075", "1234567", "9999", "234567", "4300", "15207", ""]) {
      const canon = canonicalDur(raw);
      expect(durToSec(formatDur(canon))).toBe(durToSec(canon));
      // …and the canonical digits round-trip through the display unchanged.
      expect(canonicalDur(canon)).toBe(canon);
    }
  });

  it("carries an out-of-range group instead of showing it", () => {
    expect(formatDur(canonicalDur("75"))).toBe("1:15");
    expect(durToSec(canonicalDur("75"))).toBe(75);
    // 7 digits: the leading one falls off, and what's left is re-grouped.
    expect(formatDur(canonicalDur("1234567"))).toBe("23:46:07");
  });

  it("leaves ordinary typing alone", () => {
    for (const raw of ["4", "43", "430", "4300", "15207"]) expect(canonicalDur(raw)).toBe(raw);
  });
});

describe("runFormComplete", () => {
  it("needs a distance and some duration", () => {
    const base = runToForm(run);
    expect(runFormComplete(base)).toBe(true);
    expect(runFormComplete({ ...base, km: "" })).toBe(false);
    expect(runFormComplete({ ...base, dur: "" })).toBe(false);
    // Any duration counts now. Thirty seconds used to be rejected because the
    // rule demanded hours or minutes, which the three boxes made easy to miss.
    expect(runFormComplete({ ...base, dur: "30" })).toBe(true);
  });

  // An indoor bike/elliptical has no distance comparable to running, so
  // demanding one is what made those sessions unloggable (docs/indoor-sessions.md).
  it("lets cross-training save on duration alone", () => {
    const cross = { ...runToForm(run), type: "OTHER", km: "" };
    expect(runFormComplete(cross)).toBe(true);
    expect(runFormComplete({ ...cross, dur: "" })).toBe(false);
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

  // The form offers no distance or elevation field for cross-training, so
  // switching into it has to empty them — otherwise a value the runner can no
  // longer see is saved as running volume and climb.
  it("clears distance and elevation on the switch to cross-training", () => {
    const f = setRunField({ ...runToForm(run), km: "25", elev: "300" }, "type", "OTHER");
    expect(f).toMatchObject({ km: "", elev: "" });
    expect(runFormToPatch(f)).toMatchObject({ km: 0, elevation: undefined });
  });

  // The mirror image, and the reason this lives in the change handler rather
  // than in runFormToPatch: a bike ride logged before those fields disappeared
  // must survive an unrelated edit. The aggregates neutralise it; nothing
  // silently deletes it.
  it("keeps a distance a cross-training run already had", () => {
    const legacy = runToForm({ ...run, type: "OTHER", km: 32 } as Run);
    expect(runFormToPatch(legacy).km).toBe(32);
    // Editing only the notes leaves the distance alone.
    expect(runFormToPatch(setRunField(legacy, "notes", "flat tyre")).km).toBe(32);
  });
});

describe("runFormErrors", () => {
  it("blames the field that is actually missing", () => {
    const base = runToForm(run);
    expect(runFormErrors(base)).toEqual({ km: false, duration: false });
    expect(runFormErrors({ ...base, km: "" })).toEqual({ km: true, duration: false });
    expect(runFormErrors({ ...base, dur: "" })).toEqual({ km: false, duration: true });
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
