import type { Run, RunActivity, RunPatch } from "../types";

// The manual run form, shared by Log a Run and Edit Run so the two can't drift
// on fields, validation or the H/M/S arithmetic. Everything around it differs
// (one adds, one patches; one imports files), so only the fields live here.
export type RunFormValues = {
  date: string;
  type: string;
  // Which machine a cross-training ("OTHER") session was done on. "" = unsaid,
  // which is the only valid value for every other type.
  activity: string;
  km: string;
  dH: string;
  dM: string;
  dS: string;
  hr: string;
  hrMax: string;
  elev: string;
  effort: string | number;
  notes: string;
};

export const emptyRunForm = (date: string): RunFormValues => ({
  date, type: "EASY", activity: "", km: "", dH: "", dM: "", dS: "",
  hr: "", hrMax: "", elev: "", effort: 5, notes: "",
});

export function runToForm(run: Run): RunFormValues {
  const sec = run.durationSec || 0;
  return {
    date:  run.date,
    type:  run.type || "EASY",
    activity: run.activity || "",
    km:    run.km != null ? String(run.km) : "",
    dH:    String(Math.floor(sec / 3600) || ""),
    dM:    String(Math.floor((sec % 3600) / 60) || ""),
    dS:    String(sec % 60 || ""),
    hr:    run.hr        ? String(run.hr)        : "",
    hrMax: run.hrMax     ? String(run.hrMax)     : "",
    elev:  run.elevation ? String(run.elevation) : "",
    effort: run.effort || 5,
    notes:  run.notes || "",
  };
}

export const hmsToSec = (f: Pick<RunFormValues, "dH" | "dM" | "dS">) =>
  (parseInt(f.dH, 10) || 0) * 3600 + (parseInt(f.dM, 10) || 0) * 60 + (parseInt(f.dS, 10) || 0);

// A run needs a distance and some duration; the rest is optional. The one
// exception is cross-training ("OTHER" — an indoor bike or elliptical, a swim):
// there is no comparable distance to ask for, and demanding one is what stopped
// those sessions being loggable at all. See docs/indoor-sessions.md.
export const runFormComplete = (f: RunFormValues) =>
  (f.type === "OTHER" || !!f.km) && !!(f.dM || f.dH);

export const runFormToPatch = (f: RunFormValues): RunPatch => ({
  date: f.date, type: f.type, km: parseFloat(f.km) || 0, durationSec: hmsToSec(f),
  // Only ever meaningful on a cross-training row; cleared if the type moves off
  // OTHER, so an edited run can't keep claiming it was done on a bike.
  activity: f.type === "OTHER" && f.activity ? f.activity as RunActivity : undefined,
  hr:        f.hr    ? parseInt(f.hr, 10)    : null,
  hrMax:     f.hrMax ? parseInt(f.hrMax, 10) : null,
  elevation: f.elev  ? parseInt(f.elev, 10)  : undefined,
  effort:    parseInt(String(f.effort), 10), notes: f.notes,
});
