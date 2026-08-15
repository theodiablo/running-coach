// The coach agent's bounded tool vocabulary: plan transforms over the buildPlan
// JSON plus one memory-suggestion tool. The model is an EDITOR, never an author
// — it can only act through these, and there is deliberately no free-form edit
// tool. The one load-increasing tool (add_session) is capped at the plan's
// longest training session, barred from the final 14 days, and still gated by
// the weekly-ramp validator. Every transform returns a NEW plan
// (structuredClone), refuses to touch done sessions, and never moves a RACE.
//
// Session/phase vocabulary matches the app, NOT generic lowercase names:
// EASY | TEMPO | INTERVALS | LONG | RACE | WALK | OTHER ("cross-training" maps
// to WALK). Plain ESM: imported by the Deno edge function and by Vitest.

import { HARD_TYPES } from "./validation.mjs";
import { stylePacing } from "./styles.mjs";
import { isElapsedWeek, todayYmd } from "./weeks.mjs";

const SWAP_TYPES = ["EASY", "TEMPO", "INTERVALS", "LONG", "WALK"];
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = 86400000;
const toDate = (s) => new Date(s + "T00:00:00");
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / dayMs);

// A rebuild keeps the elapsed weeks in the plan, so the model can now SEE days
// that have already been lived. They are the training record — "never edit a
// session to make past training look different from what actually happened" —
// so every mutating tool refuses them.
//
// One day of slack, because `today` is UTC while a session's date is the
// runner's local day: without it an evening message from the Americas would
// read the runner's own today as yesterday and refuse "I can't run today".
// The slack also leaves yesterday's missed session cancellable, which is
// honest record-keeping rather than a rewrite.
const PAST_EDIT_GRACE_DAYS = 1;
const isPastDate = (date, today) => daysBetween(date, today) > PAST_EDIT_GRACE_DAYS;

export class CoachToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CoachToolError";
    this.code = code;
  }
}

// Anthropic tool definitions (Messages API `tools` array). Descriptions are
// prescriptive about WHEN to use each tool, not just what it does.
export const TOOL_DEFS = [
  {
    name: "shift_workout",
    description:
      "Move one training session to a different date. Use when a day no longer works (travel, soreness needing one more rest day, spacing two hard sessions apart). Cannot move RACE sessions, completed sessions or sessions in weeks that have already passed; the new date must be inside the plan, still ahead, and before race day.",
    input_schema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The id of the session to move." },
        new_date: { type: "string", description: "Target date, YYYY-MM-DD." },
      },
      required: ["session_id", "new_date"],
    },
  },
  {
    name: "swap_session",
    description:
      "Change a session's type (EASY, TEMPO, INTERVALS, LONG or WALK), keeping its date and distance. Use to soften a hard session (e.g. INTERVALS→EASY when fatigued) or restore one. Pace and description are recomputed from the plan's target pace.",
    input_schema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        new_type: { type: "string", enum: SWAP_TYPES },
      },
      required: ["session_id", "new_type"],
    },
  },
  {
    name: "reduce_week_volume",
    description:
      "Scale down every remaining training session in one week by a factor between 0.3 and 0.95. Use for accumulated fatigue, illness recovery, or an unexpectedly heavy life week. Never increases volume, and only for a week that has not already passed.",
    input_schema: {
      type: "object",
      properties: {
        week_number: { type: "integer" },
        factor: { type: "number", description: "Multiplier in [0.3, 0.95]." },
      },
      required: ["week_number", "factor"],
    },
  },
  {
    name: "insert_recovery_week",
    description:
      "Turn one week into a recovery week: every remaining training session becomes a short EASY run (≤6 km). Use after a missed week (resume gently — never make up volume), illness, or a niggle that needs unloading. Only for a week that has not already passed.",
    input_schema: {
      type: "object",
      properties: { week_number: { type: "integer" } },
      required: ["week_number"],
    },
  },
  {
    name: "convert_to_cross_training",
    description:
      "Convert one session to WALK (no-impact cross-training / brisk walk), keeping its date. Use for impact-related niggles (knee, shin, ankle) where movement is fine but running is not.",
    input_schema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  {
    name: "reduce_session_distance",
    description:
      "Shorten ONE session's distance by a factor between 0.3 and 0.95, keeping its date and type. Use when a single session needs unloading (e.g. shorten just the long run after a heavy week) — prefer this over reduce_week_volume when the problem is one session, not the whole week.",
    input_schema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        factor: { type: "number", description: "Multiplier in [0.3, 0.95]." },
      },
      required: ["session_id", "factor"],
    },
  },
  {
    name: "cancel_session",
    description:
      "Cancel one upcoming session — it is marked skipped and will not be run. LAST RESORT: prefer shortening (reduce_session_distance), shifting, swapping easier, or converting to cross-training; cancel only when full rest is the right call. Cannot cancel RACE or completed sessions, nor sessions in weeks that have already passed, and you have no tool to un-cancel.",
    input_schema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  {
    name: "add_session",
    description:
      "Add ONE extra training session on a free day. ONLY when the runner explicitly has extra availability or asks to train more AND recent training supports it — never to make up missed volume, never during pain or illness, never inside the final 14 days before the race. Distance is capped at the plan's current longest training session, and the weekly volume ramp rule still applies to the result.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD, inside the plan, still ahead, and before race day." },
        type: { type: "string", enum: SWAP_TYPES },
        km: { type: "number", description: "Distance in km; keep it modest." },
      },
      required: ["date", "type", "km"],
    },
  },
  {
    name: "reassess_goal_feasibility",
    description:
      "Analyse whether the race goal still looks realistic given recent training (returns an assessment; does NOT change the plan). Use when the runner doubts the goal, or when repeated reductions suggest the goal itself is the problem.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "remember_runner_context",
    description:
      "Suggest ONE durable, future-useful memory for the runner's visible Coach memory field. Use sparingly for recurring injuries/pain patterns, safety constraints, schedule preferences, terrain/equipment constraints, durable training preferences, or important user corrections about themselves. Do NOT suggest facts already present in the current plan, goal/settings, recent runs, or existing Coach memory; do NOT suggest one-off events (like a single missed week), trivial chat facts, compliments, emotions, race date/distance, latest run distance, weekly mileage, or diagnoses. Suggestions are NOT saved automatically: the runner must explicitly confirm them.",
    input_schema: {
      type: "object",
      properties: {
        memory: { type: "string", description: "Short memory text without a date prefix, e.g. 'Prefers Sunday long runs.'" },
      },
      required: ["memory"],
    },
  },
  {
    name: "get_run_detail",
    description:
      "Fetch a compact digest of one recent run's recorded detail: per-km splits, heart-rate time in zones, and a downsampled pace/elevation/HR series (returns data; does NOT change the plan). Use ONLY when analysing how a specific run was actually executed would change your advice — pacing fade, HR drift, whether climbs drove the effort; most questions are answerable from the RECENT RUNS summary alone. Only runs whose summary shows hasDetail:true have data; pass that run's id. Fetch at most 1-2 runs, never routinely.",
    input_schema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "The id field of a run from RECENT RUNS." },
      },
      required: ["run_id"],
    },
  },
];

function findSession(plan, id) {
  for (const w of plan.weeks) {
    const s = w.sessions.find(x => x.id === id);
    if (s) return { week: w, session: s };
  }
  throw new CoachToolError("NOT_FOUND", `No session with id "${id}" in the plan.`);
}

// Single source of truth for "this session cannot be touched" — completed
// sessions and RACE sessions (fixed real-world events). Used both by the
// single-session guard below and by the bulk (whole-week) tools so the rule
// can't drift between the two call shapes.
const isFixed = (session) => session.type === "RACE" || session.done;

function guardEditable(session, verb, today) {
  if (session.done)
    throw new CoachToolError("DONE", `Session ${session.id} is already completed — refusing to ${verb} it.`);
  if (session.type === "RACE")
    throw new CoachToolError("IS_RACE", `Session ${session.id} is a race — races are fixed events and cannot be ${verb}ed.`);
  if (isPastDate(session.date, today))
    throw new CoachToolError("IN_PAST", `Session ${session.id} is dated ${session.date}, which has already passed — the elapsed weeks are the training record and cannot be ${verb}ed. Adjust what is still ahead.`);
}

// Pace/description derivation mirrors buildPlan's ratios off plan.targetPace.
// The multipliers come from the shared per-style table (styles.mjs) keyed by
// plan.style — the SAME table buildPlan uses, so a coach edit on a styled plan
// prescribes the style's paces, not stale balanced ones. A plan without a
// style field (built before styles existed) resolves to balanced, which keeps
// the original hardcoded 1.25/1.05/1.0 ratios byte-identical.
const paceFor = (plan, type) => {
  const tgt = plan.targetPace || 0;
  if (!tgt) return null;
  const pacing = stylePacing(plan.style);
  if (type === "EASY") return Math.round(tgt * pacing.easy);
  if (type === "LONG") return Math.round(tgt * pacing.long);
  if (type === "TEMPO") return Math.round(tgt * pacing.tempo);
  if (type === "INTERVALS") return Math.round(tgt * pacing.intervals);
  // WALK is paced only for styles where it's a real run/walk session
  // (pacing.walk set); elsewhere it stays unpaced cross-training (null),
  // preserving pre-styles behaviour byte-for-byte.
  if (type === "WALK") return pacing.walk ? Math.round(tgt * pacing.walk) : null;
  return null;
};
const fmtPace = (sec) => {
  if (!sec) return "--:--";
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
};
const descFor = (type, pace, style) => {
  if (style === "runwalk") {
    // Run/walk plans phrase everything as run/walk — no speedwork vocabulary.
    // A paced WALK is a real run/walk session (swap/add); an unpaced one is a
    // no-impact conversion and keeps the cross-training wording.
    if (type === "LONG") return "Long run/walk — gentle run/walk intervals, conversational";
    if (type === "WALK" && pace) return "Run/walk — gentle intervals, conversational";
    if (type === "WALK") return "Cross-training / brisk walk — no impact, easy effort";
    if (type === "EASY") return "Run/walk — gentle intervals, conversational";
  }
  if (type === "LONG") return "Long run — easy effort" + (pace ? " at " + fmtPace(pace) + "/km" : "");
  if (type === "TEMPO") {
    if (style === "hansons") return "Tempo — at goal race pace" + (pace ? " " + fmtPace(pace) + "/km" : "") + ", steady";
    return "Tempo run — " + (pace ? fmtPace(pace) + "/km, " : "") + "comfortably hard";
  }
  if (type === "INTERVALS") return "Intervals — repeats" + (pace ? " at " + fmtPace(pace) + "/km" : "") + " with full recovery";
  if (type === "WALK") return "Cross-training / brisk walk — no impact, easy effort";
  return "Easy run — relaxed aerobic effort";
};
// Structured descriptor mirroring descFor branch-for-branch, so a coach-edited
// or coach-added session carries an `sd` the app renders in the UI language —
// and never a STALE one left over from the session's previous type (the app
// renders `sd` in preference to `desc`, so an out-of-date `sd` would show the
// wrong sentence). `renderSd` reproduces descFor's English byte-for-byte
// (enforced by sessionDesc.test.ts). Pace-present cases reuse existing
// templates; the `*NoPace`/`coach*` variants cover the rest.
const sdFor = (type, pace, style) => {
  const p = !!pace;
  if (style === "runwalk") {
    if (type === "LONG") return { kind: "runwalk", variant: "coachLong" };
    if (type === "WALK" && pace) return { kind: "runwalk", variant: "coachShort" };
    if (type === "WALK") return { kind: "crosswalk" };
    if (type === "EASY") return { kind: "runwalk", variant: "coachShort" };
  }
  if (type === "LONG") return { kind: "long", variant: p ? "easy" : "coachEasyNoPace" };
  if (type === "TEMPO") {
    if (style === "hansons") return { kind: "tempo", variant: p ? "goalPace" : "coachGoalNoPace" };
    return { kind: "tempo", variant: p ? "comfortablyHard" : "coachComfortNoPace" };
  }
  if (type === "INTERVALS") return { kind: "intervals", variant: p ? "coachGeneric" : "coachGenericNoPace" };
  if (type === "WALK") return { kind: "crosswalk" };
  return { kind: "easy", variant: "relaxed" };
};

// Apply one tool call, returning a NEW plan. Throws CoachToolError on refusal;
// the caller reports it back to the model as an is_error tool_result.
// reassess_goal_feasibility is handled by the caller (it reads context, not
// the plan) and is not accepted here.
//
// opts.today (YYYY-MM-DD) is what "already passed" is measured against — the
// engine passes the same `today` the model is shown, so a refusal can never
// disagree with the context the model reasoned from.
export function applyToolCall(plan, name, input = {}, opts = {}) {
  const p = structuredClone(plan);
  const today = opts.today || todayYmd();
  // Whole-week tools take a week number, so they need their own past check —
  // guardEditable only sees one session at a time.
  const guardWeekEditable = (week, verb) => {
    if (isElapsedWeek(week, today))
      throw new CoachToolError("IN_PAST", `Week ${week.weekNumber} ended on ${week.startDate} + 7 days and has already passed — it is the training record and cannot be ${verb}. Adjust a week that is still ahead.`);
  };
  switch (name) {
    case "shift_workout": {
      const { session_id, new_date } = input;
      if (!YMD.test(new_date || ""))
        throw new CoachToolError("BAD_INPUT", "new_date must be YYYY-MM-DD.");
      const { week, session } = findSession(p, session_id);
      guardEditable(session, "move", today);
      if (isPastDate(new_date, today))
        throw new CoachToolError("IN_PAST", `${new_date} has already passed — a session can only be moved to a day still ahead.`);
      if (new_date >= p.raceDate)
        throw new CoachToolError("AFTER_RACE", "Cannot move a training session onto/after race day.");
      const target = p.weeks.find(w => {
        const off = (toDate(new_date) - toDate(w.startDate)) / dayMs;
        return off >= 0 && off < 7;
      });
      if (!target)
        throw new CoachToolError("OUT_OF_PLAN", `${new_date} is outside the plan window.`);
      week.sessions = week.sessions.filter(s => s.id !== session_id);
      session.date = new_date;
      target.sessions.push(session);
      target.sessions.sort((a, b) => a.date.localeCompare(b.date));
      return p;
    }
    case "swap_session": {
      const { session_id, new_type } = input;
      if (!SWAP_TYPES.includes(new_type))
        throw new CoachToolError("BAD_INPUT", `new_type must be one of ${SWAP_TYPES.join(", ")}.`);
      const { session } = findSession(p, session_id);
      guardEditable(session, "swap", today);
      session.type = new_type;
      session.pace = paceFor(p, new_type);
      session.desc = descFor(new_type, session.pace, p.style);
      session.sd = sdFor(new_type, session.pace, p.style);
      return p;
    }
    case "reduce_week_volume": {
      const { week_number, factor } = input;
      if (typeof factor !== "number" || factor < 0.3 || factor > 0.95)
        throw new CoachToolError("BAD_INPUT", "factor must be a number in [0.3, 0.95].");
      const week = p.weeks.find(w => w.weekNumber === week_number);
      if (!week) throw new CoachToolError("NOT_FOUND", `No week ${week_number} in the plan.`);
      guardWeekEditable(week, "scaled down");
      for (const s of week.sessions) {
        if (isFixed(s)) continue;
        s.km = Math.max(1.5, Math.round(s.km * factor * 10) / 10);
      }
      return p;
    }
    case "insert_recovery_week": {
      const { week_number } = input;
      const week = p.weeks.find(w => w.weekNumber === week_number);
      if (!week) throw new CoachToolError("NOT_FOUND", `No week ${week_number} in the plan.`);
      guardWeekEditable(week, "turned into a recovery week");
      for (const s of week.sessions) {
        if (isFixed(s)) continue;
        s.type = "EASY";
        s.km = Math.max(1.5, Math.min(6, Math.round(s.km * 0.6 * 10) / 10));
        s.pace = paceFor(p, "EASY");
        s.desc = "Recovery run — very easy effort, walk breaks welcome";
        s.sd = { kind: "recovery" };
      }
      return p;
    }
    case "reduce_session_distance": {
      const { session_id, factor } = input;
      if (typeof factor !== "number" || factor < 0.3 || factor > 0.95)
        throw new CoachToolError("BAD_INPUT", "factor must be a number in [0.3, 0.95].");
      const { session } = findSession(p, session_id);
      guardEditable(session, "shorten", today);
      session.km = Math.max(1.5, Math.round(session.km * factor * 10) / 10);
      return p;
    }
    case "cancel_session": {
      const { session_id } = input;
      const { session } = findSession(p, session_id);
      guardEditable(session, "cancel", today);
      session.skipped = true;
      return p;
    }
    case "add_session": {
      const { date, type, km } = input;
      if (!YMD.test(date || ""))
        throw new CoachToolError("BAD_INPUT", "date must be YYYY-MM-DD.");
      if (!SWAP_TYPES.includes(type))
        throw new CoachToolError("BAD_INPUT", `type must be one of ${SWAP_TYPES.join(", ")}.`);
      if (typeof km !== "number" || !(km > 0))
        throw new CoachToolError("BAD_INPUT", "km must be a positive number.");
      if (isPastDate(date, today))
        throw new CoachToolError("IN_PAST", `${date} has already passed — a session cannot be added to a day that has been lived. Never backfill missed training.`);
      if (date >= p.raceDate)
        throw new CoachToolError("AFTER_RACE", "Cannot add a training session on/after race day.");
      if (daysBetween(date, p.raceDate) <= 14)
        throw new CoachToolError("TAPER", "No added sessions inside the final 14 days — the taper sheds load, it never gains sessions.");
      const target = p.weeks.find(w => {
        const off = daysBetween(w.startDate, date);
        return off >= 0 && off < 7;
      });
      if (!target)
        throw new CoachToolError("OUT_OF_PLAN", `${date} is outside the plan window.`);
      // Cap at the plan's established range: an "extra run" can never smuggle
      // in a new peak session. Live weeks only — the retained history can hold
      // the peak long run of a previous block, and a bigger goal ago is not
      // licence to add a session that size to the block being run now.
      const cap = Math.max(0, ...p.weeks.filter(w => !isElapsedWeek(w, today))
        .flatMap(w => w.sessions)
        .filter(s => s.type !== "RACE" && !s.skipped).map(s => s.km));
      if (cap > 0 && km > cap)
        throw new CoachToolError("TOO_LONG", `km must not exceed the plan's current longest training session (${cap} km).`);
      const ids = new Set(p.weeks.flatMap(w => w.sessions.map(s => s.id)));
      let id = `coach-add-${date}`;
      for (let n = 2; ids.has(id); n++) id = `coach-add-${date}-${n}`;
      const pace = paceFor(p, type);
      target.sessions.push({ id, date, type, km: Math.round(km * 10) / 10, pace, desc: descFor(type, pace, p.style), sd: sdFor(type, pace, p.style), done: false });
      target.sessions.sort((a, b) => a.date.localeCompare(b.date));
      return p;
    }
    case "convert_to_cross_training": {
      const { session_id } = input;
      const { session } = findSession(p, session_id);
      guardEditable(session, "convert", today);
      // Deliberately unpaced regardless of style: a conversion is the coach's
      // pain/illness relief valve, and "no impact" must stay true even on a
      // runwalk plan whose ordinary WALK sessions are paced run/walk work.
      session.type = "WALK";
      session.pace = null;
      session.desc = descFor("WALK", null, p.style);
      session.sd = sdFor("WALK", null, p.style);
      return p;
    }
    default:
      throw new CoachToolError("UNKNOWN_TOOL", `Unknown tool "${name}".`);
  }
}

// reassess_goal_feasibility executor: a deterministic assessment computed from
// the request context (goal fields + recent-run window), returned to the model
// as the tool result. Pure and unit-testable; no plan mutation.
export function assessGoalFeasibility(ctx) {
  const { goal, targetPace, recentRuns = [] } = ctx;
  const { goalSec, distanceKm, raceDate } = goal || {};
  if (!goalSec || !distanceKm) return "No race goal is configured — nothing to assess.";
  // OTHER is cross-training: its distance is not a running distance, so it must
  // never reach weeklyKm / longest / bestPace — a logged bike ride would read as
  // a fast long run and talk the runner into a more ambitious goal.
  const runs = recentRuns.filter(r => r && r.km > 0 && r.durationSec > 0 && r.type !== "WALK" && r.type !== "OTHER");
  if (!runs.length)
    return "No recent runs with distance+time logged — cannot assess fitness; advise the runner to log a few runs first.";
  const weeks = 4;
  const cutoff = new Date(Date.now() - weeks * 7 * dayMs).toISOString().slice(0, 10);
  const recent = runs.filter(r => r.date >= cutoff);
  // Prefer the actual last-N-weeks window for the headline stats; only fall
  // back to the wider (already ≤30-run) history when nothing recent exists,
  // and say so explicitly rather than silently mislabeling old data as recent.
  const sample = recent.length ? recent : runs;
  const weeklyKm = recent.reduce((t, r) => t + r.km, 0) / weeks;
  const longest = Math.max(...sample.map(r => r.km));
  const bestPace = Math.min(...sample.map(r => Math.round(r.durationSec / r.km)));
  const lines = [
    `Goal: ${distanceKm} km on ${raceDate} at ~${fmtPace(targetPace)}/km target pace.`,
    `Last ${weeks} weeks: ~${weeklyKm.toFixed(1)} km/week` + (recent.length
      ? `; longest recent run ${longest.toFixed(1)} km; best recent pace ${fmtPace(bestPace)}/km.`
      : ` (no runs logged in that window); longest run on record ${longest.toFixed(1)} km; best pace on record ${fmtPace(bestPace)}/km.`),
  ];
  if (bestPace > targetPace * 1.15)
    lines.push("Assessment: goal pace is far below anything shown recently — the goal looks UNREALISTIC right now; recommend discussing a slower goal or a later race.");
  else if (longest < distanceKm * 0.5 && distanceKm > 15)
    lines.push("Assessment: endurance is the gap (longest run under half the race distance) — the goal is AT RISK; protect the long-run progression above all.");
  else if (bestPace <= targetPace * 0.93)
    lines.push("Assessment: recent paces are comfortably faster than goal pace — the goal looks CONSERVATIVE. If the plan feels too easy, suggest a more ambitious goal in the plan settings (the whole plan is rebuilt from the goal) rather than hand-editing sessions.");
  else
    lines.push("Assessment: the goal looks broadly plausible if the remaining plan is executed consistently.");
  return lines.join("\n");
}
