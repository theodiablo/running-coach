import type { Run, RunPatch } from "../types";

// The manual run form, shared by Log a Run and Edit Run so the two can't drift
// on fields, validation or the H/M/S arithmetic. Everything around it differs
// (one adds, one patches; one imports files), so only the fields live here.
export type RunFormValues = {
  date: string;
  type: string;
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
  date, type: "EASY", km: "", dH: "", dM: "", dS: "",
  hr: "", hrMax: "", elev: "", effort: 5, notes: "",
});

export function runToForm(run: Run): RunFormValues {
  const sec = run.durationSec || 0;
  return {
    date:  run.date,
    type:  run.type || "EASY",
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

// A run needs a distance and some duration; the rest is optional.
export const runFormComplete = (f: RunFormValues) => !!f.km && !!(f.dM || f.dH);

export const runFormToPatch = (f: RunFormValues): RunPatch => ({
  date: f.date, type: f.type, km: parseFloat(f.km), durationSec: hmsToSec(f),
  hr:        f.hr    ? parseInt(f.hr, 10)    : null,
  hrMax:     f.hrMax ? parseInt(f.hrMax, 10) : null,
  elevation: f.elev  ? parseInt(f.elev, 10)  : undefined,
  effort:    parseInt(String(f.effort), 10), notes: f.notes,
});
