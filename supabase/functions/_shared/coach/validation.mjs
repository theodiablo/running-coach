// Shared training-plan validator — the ONE validator for buildPlan and the
// coach agent. Plain dependency-free ESM: imported by the Deno edge function
// and re-exported for the Vite app / Vitest. `errors` block a proposal,
// `warnings` pass but are surfaced; `validatePlan(plan, { baseline })` waives
// errors that already exist identically in the baseline, so a pre-existing
// issue never bricks the agent. Rules and severities: docs/coach-agent.md.

import { isElapsedWeek, todayYmd } from "./weeks.mjs";

export const SESSION_TYPES = ["EASY", "TEMPO", "INTERVALS", "LONG", "RACE", "WALK", "OTHER"];
export const PHASES = ["BASE", "BUILD", "PEAK", "TAPER", "RACE"];
// Sessions that count as "hard" for spacing/taper rules.
export const HARD_TYPES = ["TEMPO", "INTERVALS", "LONG", "RACE"];

// Week-over-week volume ramp: next ≤ ref × RAMP_FACTOR + RAMP_SLACK_KM, where
// ref looks back two weeks so a recovery week doesn't forbid resuming volume.
const RAMP_FACTOR = 1.3;
const RAMP_SLACK_KM = 3;
// A single *training* session longer than this is never OK (ultra long-run
// ceiling in buildPlan is 36 km). RACE sessions are exempt (UTMB is 171 km).
const MAX_TRAINING_KM = 40;
// Taper integrity windows (days before race day).
const NO_INTERVALS_DAYS = 14;
const NO_TEMPO_DAYS = 7;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = 86400000;
const toDate = (s) => new Date(s + "T00:00:00");
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / dayMs);

// Collect raw issues (no baseline waiver). Each issue:
// { code, severity: "error"|"warn", message, weekNumber?, sessionId? }
function collectIssues(plan, today) {
  const issues = [];
  const err = (code, message, extra) => issues.push({ code, severity: "error", message, ...extra });
  const warn = (code, message, extra) => issues.push({ code, severity: "warn", message, ...extra });

  // ── structure (a malformed plan is unsafe by definition) ──────────────────
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.weeks) || !plan.weeks.length) {
    err("MALFORMED", "Plan must be an object with a non-empty weeks array.");
    return issues;
  }
  if (!YMD.test(plan.raceDate || "")) {
    err("MALFORMED", "Plan raceDate must be a YYYY-MM-DD string.");
    return issues;
  }

  const seenIds = new Set();
  for (const w of plan.weeks) {
    const wk = { weekNumber: w && w.weekNumber };
    if (!w || typeof w.weekNumber !== "number" || !YMD.test(w.startDate || "") ||
        !PHASES.includes(w.phase) || !Array.isArray(w.sessions)) {
      err("MALFORMED", `Week ${w && w.weekNumber} is malformed.`, wk);
      continue;
    }
    for (const s of w.sessions) {
      const ctx = { ...wk, sessionId: s && s.id };
      if (!s || typeof s.id !== "string" || !YMD.test(s.date || "") ||
          !SESSION_TYPES.includes(s.type) || typeof s.km !== "number" || !(s.km > 0)) {
        err("MALFORMED", `Session ${s && s.id} in week ${w.weekNumber} is malformed.`, ctx);
        continue;
      }
      if (seenIds.has(s.id)) err("DUPLICATE_ID", `Duplicate session id ${s.id}.`, ctx);
      seenIds.add(s.id);
      // RACE sessions are exempt from the week window: buildPlan caps plans at
      // 24 weeks, so a distant race day legitimately sits outside its "race
      // week" row (and a very close race can sit before it).
      const off = daysBetween(w.startDate, s.date);
      if (s.type !== "RACE" && (off < 0 || off >= 7))
        err("OUT_OF_WEEK", `Session ${s.id} (${s.date}) is outside week ${w.weekNumber} (${w.startDate}).`, ctx);
      if (s.type !== "RACE" && s.date >= plan.raceDate)
        err("AFTER_RACE", `Training session ${s.id} falls on/after race day.`, ctx);
      if (s.type === "RACE" && s.date > plan.raceDate)
        err("AFTER_RACE", `Race session ${s.id} falls after the main race day.`, ctx);
      if (s.type !== "RACE" && s.km > MAX_TRAINING_KM)
        err("SESSION_TOO_LONG", `Session ${s.id} is ${s.km} km — over the ${MAX_TRAINING_KM} km training ceiling.`, ctx);
    }
  }
  // Structure must be sound before load rules make sense.
  if (issues.some(i => i.severity === "error")) return issues;

  // A skipped session (user-skipped, or cancelled by the coach's
  // cancel_session) will not be run: it contributes no training load, so the
  // volume/spacing/taper rules ignore it. Structural checks above still apply.
  //
  // Elapsed weeks (a rebuild keeps them — carryProgress) split the load rules
  // in two, and the line is what each rule is ABOUT rather than what it reads:
  //
  // - The SUBJECT of an error must be a week still ahead. The coach has no tool
  //   that touches a past date, so an error on history is unfixable, and one
  //   unfixable error invalidates every proposal that runner ever asks for.
  // - The REFERENCE a rule measures against still spans the whole plan. What
  //   was already run is a fact about this training block: dropping it would
  //   make the ramp forget the volume a runner is coming back from and let the
  //   taper's peak collapse to whatever is left, which is exactly backwards —
  //   both weaken the guard in the late weeks, when most of the plan is past.
  const weeks = plan.weeks;
  const isLive = (w) => !isElapsedWeek(w, today);
  const isRaceWeek = (w) => w.sessions.some(s => s.type === "RACE");
  const total = (w) => w.sessions.reduce((t, s) => t + (s.type === "RACE" || s.skipped ? 0 : s.km), 0);
  const totals = weeks.map(total);

  // ── safety: weekly volume ramp ─────────────────────────────────────────────
  // The reference looks back two full weeks so a recovery week doesn't lower
  // the ceiling — resuming the planned volume after an easy week is fine.
  // Skipped sessions carry no load, so a fully-skipped week reads as 0; if we
  // stopped at the two-week window the ceiling could collapse to 0 (both prior
  // weeks skipped) and silently un-gate the ramp — exactly the aggressive
  // resume-after-a-layoff case this rule exists to catch. So when the window is
  // empty, walk further back to the most recent week with real load and use
  // that as the ceiling instead of disabling the check.
  const refKm = (i) => {
    let ref = Math.max(totals[i - 1], i >= 2 ? totals[i - 2] : 0);
    for (let k = i - 3; ref === 0 && k >= 0; k--) ref = totals[k];
    return ref;
  };
  for (let i = 1; i < weeks.length; i++) {
    const w = weeks[i];
    if (!isLive(w)) continue;
    if (w.phase === "TAPER" || w.phase === "RACE" || isRaceWeek(weeks[i - 1])) continue;
    const ref = refKm(i);
    if (ref > 0 && totals[i] > ref * RAMP_FACTOR + RAMP_SLACK_KM) {
      issues.push({ code: "RAMP_EXCEEDED", severity: "error", weekNumber: w.weekNumber,
        message: `Week ${w.weekNumber} volume (${totals[i].toFixed(1)} km) jumps too far above the previous weeks (~${ref.toFixed(1)} km). Never "make up" missed volume.` });
    }
  }

  // ── safety: hard sessions on consecutive days ──────────────────────────────
  // `live` rides along so a rule can read a past session as context (the
  // session before a live one) without ever reporting against it.
  const all = weeks.flatMap(w => w.sessions.map(s => ({ ...s, weekNumber: w.weekNumber, live: isLive(w) })))
    .filter(s => !s.skipped)
    .sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1], b = all[i];
    if (!b.live) continue;
    if (!HARD_TYPES.includes(a.type) || !HARD_TYPES.includes(b.type)) continue;
    if (daysBetween(a.date, b.date) !== 1) continue;
    if (a.type === "RACE" || b.type === "RACE") {
      warn("RACE_ADJACENT", `Hard session ${b.id} sits next to race ${a.type === "RACE" ? a.id : b.id} — consider easing it.`,
        { weekNumber: b.weekNumber, sessionId: b.id });
    } else {
      issues.push({ code: "HARD_BACK_TO_BACK", severity: "error", weekNumber: b.weekNumber, sessionId: b.id,
        previousSessionId: a.id, previousSessionType: a.type, previousSessionDate: a.date,
        sessionType: b.type, sessionDate: b.date,
        message: `Hard sessions ${a.id} (${a.type}) and ${b.id} (${b.type}) are on consecutive days — at least one easy/rest day is required between hard efforts.` });
    }
  }
  for (let i = 1; i < all.length; i++) {
    if (all[i].live && all[i].date === all[i - 1].date && all[i].type !== "RACE" && all[i - 1].type !== "RACE")
      warn("SAME_DAY", `Two training sessions share ${all[i].date}.`, { sessionId: all[i].id });
  }

  // ── safety: taper integrity ────────────────────────────────────────────────
  for (const s of all) {
    if (!s.live || s.type === "RACE" || s.date >= plan.raceDate) continue;
    const gap = daysBetween(s.date, plan.raceDate);
    if (s.type === "INTERVALS" && gap <= NO_INTERVALS_DAYS)
      issues.push({ code: "TAPER_INTERVALS", severity: "error", sessionId: s.id, weekNumber: s.weekNumber,
        message: `Intervals ${s.id} only ${gap} days before the race — no intervals inside the final ${NO_INTERVALS_DAYS} days.` });
    if (s.type === "TEMPO" && gap <= NO_TEMPO_DAYS)
      issues.push({ code: "TAPER_TEMPO", severity: "error", sessionId: s.id, weekNumber: s.weekNumber,
        message: `Tempo ${s.id} only ${gap} days before the race — no tempo inside the final ${NO_TEMPO_DAYS} days.` });
  }
  // The final two full weeks before the race must actually shed volume.
  if (weeks.length >= 6) {
    const pre = weeks.filter(w => w.phase !== "TAPER" && w.phase !== "RACE");
    const peak = Math.max(...pre.map(total), 0);
    const lastTwo = weeks.filter(w => isLive(w) &&
      w.phase !== "RACE" && daysBetween(w.startDate, plan.raceDate) <= 14 && !isRaceWeek(w));
    for (const w of lastTwo) {
      if (peak > 0 && total(w) > peak * 0.85)
        issues.push({ code: "TAPER_VOLUME", severity: "error", weekNumber: w.weekNumber,
          message: `Week ${w.weekNumber} (${total(w).toFixed(1)} km) is not tapering — the final two weeks must stay well below the peak (${peak.toFixed(1)} km).` });
    }
  }

  return issues;
}

const issueKey = (i) => {
  const base = `${i.code}|${i.weekNumber ?? ""}|${i.sessionId ?? ""}`;
  if (i.code === "HARD_BACK_TO_BACK") {
    return `${base}|${i.previousSessionId ?? ""}|${i.previousSessionType ?? ""}|${i.previousSessionDate ?? ""}|${i.sessionType ?? ""}|${i.sessionDate ?? ""}`;
  }
  return base;
};

// Validate a plan. Returns { ok, errors, warnings } where each entry is
// { code, message, severity, weekNumber?, sessionId? }.
//
// opts.baseline: the plan the proposal was derived from. Errors present
// identically in the baseline are waived (reported as warnings tagged
// preexisting) — the agent must not make things worse, but may operate on a
// plan that already violates a rule.
//
// opts.today (YYYY-MM-DD): which weeks count as already lived. The edge
// function passes the same `today` the model is shown, so a round is scored
// against one clock; it defaults to the real date for app-side callers.
export function validatePlan(plan, opts = {}) {
  const today = opts.today || todayYmd();
  let issues = collectIssues(plan, today);
  if (opts.baseline) {
    const baselineKeys = new Set(collectIssues(opts.baseline, today).map(issueKey));
    // Weekly totals per weekNumber, for the RAMP not-worse waiver below.
    const weekTotal = (p, n) => p.weeks?.find(w => w.weekNumber === n)
      ?.sessions.reduce((t, s) => t + (s.type === "RACE" || s.skipped ? 0 : s.km), 0);
    issues = issues.map(i => {
      if (i.severity !== "error") return i;
      if (baselineKeys.has(issueKey(i))) return { ...i, severity: "warn", preexisting: true };
      // A ramp flag on a week whose volume did NOT grow vs the baseline is a
      // false positive (e.g. the preceding week was just cut to a recovery
      // week) — "making up volume" requires the week to actually get bigger.
      if (i.code === "RAMP_EXCEEDED") {
        const before = weekTotal(opts.baseline, i.weekNumber);
        const after = weekTotal(plan, i.weekNumber);
        if (before != null && after != null && after <= before + 0.01)
          return { ...i, severity: "warn", preexisting: true };
      }
      return i;
    });
  }
  const errors = issues.filter(i => i.severity === "error");
  const warnings = issues.filter(i => i.severity === "warn");
  return { ok: errors.length === 0, errors, warnings };
}

// Compact human/model-readable rendering of a validation result.
export function formatValidation(result) {
  const line = (i) => `- [${i.code}] ${i.message}`;
  const parts = [];
  if (result.errors.length) parts.push("ERRORS:\n" + result.errors.map(line).join("\n"));
  if (result.warnings.length) parts.push("Warnings:\n" + result.warnings.map(line).join("\n"));
  return parts.join("\n") || "Plan is valid.";
}
