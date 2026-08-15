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

// Effort is 1..10, and 0 means "didn't say" — the slider's resting position.
// It used to default to 5, so a run logged without touching it was
// indistinguishable from one deliberately rated 5, including to the coach,
// which reads the field.
export const EFFORT_UNSET = 0;

export const emptyRunForm = (date: string): RunFormValues => ({
  date, type: "EASY", activity: "", km: "", dH: "", dM: "", dS: "",
  hr: "", hrMax: "", elev: "", effort: EFFORT_UNSET, notes: "",
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
    effort: run.effort || EFFORT_UNSET,
    notes:  run.notes || "",
  };
}

// Does this form have anything worth expanding the details section for? Used to
// open it pre-filled rather than hiding data a watch import or an edit brought
// with it.
export const runFormHasDetail = (f: RunFormValues) =>
  !!(f.hr || f.hrMax || f.elev || f.notes || Number(f.effort) > EFFORT_UNSET);

export const hmsToSec = (f: Pick<RunFormValues, "dH" | "dM" | "dS">) =>
  (parseInt(f.dH, 10) || 0) * 3600 + (parseInt(f.dM, 10) || 0) * 60 + (parseInt(f.dS, 10) || 0);

// A run needs a distance and some duration; the rest is optional. The one
// exception is cross-training ("OTHER" — an indoor bike or elliptical, a swim):
// there is no comparable distance to ask for, and demanding one is what stopped
// those sessions being loggable at all. See docs/indoor-sessions.md.
//
// Per field, so the message can sit on the field it's about — one banner saying
// "distance and duration are required" was wrong for cross-training (no
// distance needed) and unhelpful for a run typed into the seconds box, which
// fails this rule with every box visibly filled in.
export type RunFormErrors = { km: boolean; duration: boolean };

export const runFormErrors = (f: RunFormValues): RunFormErrors => ({
  km: f.type !== "OTHER" && !f.km,
  duration: !(f.dM || f.dH),
});

export const runFormComplete = (f: RunFormValues) => {
  const e = runFormErrors(f);
  return !e.km && !e.duration;
};

export const runFormToPatch = (f: RunFormValues): RunPatch => ({
  date: f.date, type: f.type,
  // A cross-training session carries no running distance — the form offers no
  // field for one, and a distance left over from a type switch must not survive
  // as running volume. See docs/indoor-sessions.md.
  km: f.type === "OTHER" ? 0 : parseFloat(f.km) || 0,
  durationSec: hmsToSec(f),
  // Only ever meaningful on a cross-training row; cleared if the type moves off
  // OTHER, so an edited run can't keep claiming it was done on a bike.
  activity: f.type === "OTHER" && f.activity ? f.activity as RunActivity : undefined,
  hr:        f.hr    ? parseInt(f.hr, 10)    : null,
  hrMax:     f.hrMax ? parseInt(f.hrMax, 10) : null,
  elevation: f.elev  ? parseInt(f.elev, 10)  : undefined,
  effort:    Number(f.effort) > EFFORT_UNSET ? parseInt(String(f.effort), 10) : null,
  notes: f.notes,
});
