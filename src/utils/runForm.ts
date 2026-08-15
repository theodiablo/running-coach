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
  // Duration as the raw digit string the runner typed, filled right to left:
  // "4300" is 43:00, "15207" is 1:52:07. One field instead of three boxes —
  // it's the order a watch face or a race result is already written in, and it
  // costs one tap and one keyboard on a phone instead of three. Format for
  // display with `formatDur`, read with `durToSec`.
  dur: string;
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
  date, type: "EASY", activity: "", km: "", dur: "",
  hr: "", hrMax: "", elev: "", effort: EFFORT_UNSET, notes: "",
});

// ── Duration: digit string ⇄ seconds ────────────────────────────────────────
// At most 6 digits (99:59:59). The parse pads left, so any prefix is valid
// while typing — which is what removes the old "seconds alone isn't a duration"
// dead end: every digit string is a duration.
const DUR_MAX_DIGITS = 6;

export const normalizeDur = (raw: string) =>
  raw.replace(/\D/g, "").slice(-DUR_MAX_DIGITS).replace(/^0+(?=\d)/, "");

export const durToSec = (digits: string): number => {
  const d = normalizeDur(digits).padStart(6, "0");
  return parseInt(d.slice(0, 2), 10) * 3600 + parseInt(d.slice(2, 4), 10) * 60 + parseInt(d.slice(4, 6), 10);
};

export const secToDur = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  if (!s) return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), rest = s % 60;
  const digits = h
    ? String(h) + String(m).padStart(2, "0") + String(rest).padStart(2, "0")
    : m
      ? String(m) + String(rest).padStart(2, "0")
      : String(rest);
  return normalizeDur(digits);
};

// What the field shows: the digits grouped as the runner reads them back.
export const formatDur = (digits: string): string => {
  const d = normalizeDur(digits);
  if (!d) return "";
  if (d.length <= 2) return "0:" + d.padStart(2, "0");
  if (d.length <= 4) return d.slice(0, -2) + ":" + d.slice(-2);
  return d.slice(0, -4) + ":" + d.slice(-4, -2) + ":" + d.slice(-2);
};

export function runToForm(run: Run): RunFormValues {
  const sec = run.durationSec || 0;
  return {
    date:  run.date,
    type:  run.type || "EASY",
    activity: run.activity || "",
    km:    run.km != null ? String(run.km) : "",
    dur:   secToDur(sec),
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

// Separate h/m/s boxes, kept for the race-time entry in RacesView. The run form
// no longer has them — see `dur`.
export const hmsToSec = (f: { dH: string; dM: string; dS: string }) =>
  (parseInt(f.dH, 10) || 0) * 3600 + (parseInt(f.dM, 10) || 0) * 60 + (parseInt(f.dS, 10) || 0);

// A run needs a distance and some duration; the rest is optional. The one
// exception is cross-training ("OTHER" — an indoor bike or elliptical, a swim):
// there is no comparable distance to ask for, and demanding one is what stopped
// those sessions being loggable at all. See docs/indoor-sessions.md.
//
// Per field, so the message can sit on the field it's about — one banner saying
// "distance and duration are required" was wrong for cross-training, which
// needs no distance.
export type RunFormErrors = { km: boolean; duration: boolean };

export const runFormErrors = (f: RunFormValues): RunFormErrors => ({
  km: f.type !== "OTHER" && !f.km,
  // Any duration at all. The old rule demanded hours or minutes, so a run typed
  // into the seconds box failed with every box visibly filled in.
  duration: durToSec(f.dur) <= 0,
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
  durationSec: durToSec(f.dur),
  // Only ever meaningful on a cross-training row; cleared if the type moves off
  // OTHER, so an edited run can't keep claiming it was done on a bike.
  activity: f.type === "OTHER" && f.activity ? f.activity as RunActivity : undefined,
  hr:        f.hr    ? parseInt(f.hr, 10)    : null,
  hrMax:     f.hrMax ? parseInt(f.hrMax, 10) : null,
  elevation: f.elev  ? parseInt(f.elev, 10)  : undefined,
  effort:    Number(f.effort) > EFFORT_UNSET ? parseInt(String(f.effort), 10) : null,
  notes: f.notes,
});
