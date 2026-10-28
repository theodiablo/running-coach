// Where the runner stands relative to the plan's main race: the core of
// src/utils/planPhase.ts (typed wrapper), shared so the coach reads the same
// phase the app shows. Plain dependency-free ESM like recovery.mjs; dates are
// YYYY-MM-DD strings and the clock arrives as `today`, so no Date and no i18n.
// Detail: docs/training-plan.md ("Where the runner stands").

import { goalKind } from "./recovery.mjs";

export const RACE_WEEK_DAYS = 7;
export const DEBRIEF_ASK_DAYS = 28;
export const DEBRIEF_RESULT_DAYS = 2;

// Rebuilds carry old weeks under this id prefix (plan.ts): history, not a race to come.
const HISTORY_PREFIX = "past-";

// Days since the epoch for a YYYY-MM-DD, by civil-calendar arithmetic.
function dayNumber(ymd) {
  const [y0, m, d] = ymd.split("-").map(Number);
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe;
}

const daysBetween = (from, to) => dayNumber(to) - dayNumber(from);

// The plan's own RACE session (buildPlan ids it "race"), else the RACE session
// dated plan.raceDate for plans a coach edit reshaped. Onboarding builds without
// mainEditionId, so the edition falls back to the settings' target when they
// name the same date.
export function mainRace(plan, settings) {
  const raceDate = String((plan && plan.raceDate) || "");
  let byDate = null;
  for (const w of (plan && plan.weeks) || []) {
    for (const s of w.sessions || []) {
      if (s.type !== "RACE" || s.id.startsWith(HISTORY_PREFIX)) continue;
      const hit = { wNum: w.weekNumber, sId: s.id, date: s.date, km: Number(s.km) || 0, session: s,
        editionId: s.editionId ?? (settings && settings.raceDate === s.date ? settings.targetEditionId ?? null : null) };
      if (s.id === "race") return hit;
      if (!byDate && raceDate && s.date === raceDate) byDate = hit;
    }
  }
  return byDate;
}

const windowLeft = (w, today) =>
  w && typeof w.until === "string" && w.until >= today ? { until: w.until, daysLeft: daysBetween(today, w.until) } : null;

const openPhase = (plan, today) => {
  const g = plan.goal;
  const weeks = g && g.startDate ? Math.floor(daysBetween(g.startDate, today) / 7) : 0;
  const per = Number(g && g.blockWeeks) > 0 ? Number(g.blockWeeks) : 4;
  const next = plan.weeks.flatMap(w => w.sessions)
    .filter(s => s.sd && s.sd.kind === "checkpoint" && !s.done && !s.skipped && s.date >= today)
    .map(s => s.date).sort()[0];
  return {
    phase: "open", race: null, kind: goalKind(plan),
    target: g && (g.target === "faster" || g.target === "further") ? g.target : "healthy", light: !!(g && g.light),
    block: Math.max(1, Math.floor(weeks / per) + 1), checkpoint: next ?? null,
    recovery: windowLeft(plan.openedAfter, today),
  };
};

// input: { plan, settings, participations, runs }. settings only needs
// raceDate and targetEditionId.
export function planPhase({ plan, settings, participations, runs }, today) {
  if (plan && goalKind(plan) !== "race") return openPhase(plan, today);
  const race = mainRace(plan, settings);
  if (!race) return null;
  const part = race.editionId ? (participations || []).find(p => p.editionId === race.editionId) : undefined;
  const daysSince = daysBetween(race.date, today);
  const s = race.session;
  // A participation settles it too: detection used to write only that.
  const settled = s.done ? "done" : s.skipped ? "skipped"
    : part && part.status === "done" ? "done" : part && part.status === "skipped" ? "skipped" : null;
  const raceRunId = s.runId || (part && part.runId) || null;
  const run = raceRunId ? (runs || []).find(r => r.id === raceRunId) : undefined;
  const resultSec = (part && part.timeSec) ?? (run && run.durationSec) ?? null;
  const base = { race, catalogue: !!race.editionId, daysSince, settled, resultSec, raceRunId };
  const own = windowLeft(plan && plan.recovery, today);

  if (settled === "skipped") return { ...base, phase: "choosing", recovery: null };
  // A plan opened right after a race carries that race's recovery into its run-up.
  if (daysSince < 0) return { ...base, phase: -daysSince <= RACE_WEEK_DAYS ? "raceWeek" : "active", recovery: windowLeft(plan && plan.openedAfter, today) };
  if (settled === "done") {
    if (run && run.effort == null && daysSince <= DEBRIEF_RESULT_DAYS)
      return { ...base, phase: "debrief", debrief: "result", recovery: own };
    return own ? { ...base, phase: "recovery", recovery: own } : { ...base, phase: "choosing", recovery: null };
  }
  if (daysSince === 0) return { ...base, phase: "raceWeek", recovery: null };
  return daysSince <= DEBRIEF_ASK_DAYS
    ? { ...base, phase: "debrief", debrief: "ask", recovery: own }
    : { ...base, phase: "choosing", recovery: null };
}

const hms = (sec) => {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
};

// What the coach is told about the race, or null while the plan is heading for
// it (nothing to say, so existing contexts stay byte-identical) unless a plan
// opened behind an earlier race is still inside that race's recovery.
// openedAfter on the plan carries the race's own km for the open-plan case.
export function raceStatus(input, today, goalSec) {
  let info = null;
  try { info = planPhase(input, today); } catch { return null; } // a malformed plan must not cost the round
  if (!info) return null;
  const ahead = info.phase === "active" || info.phase === "raceWeek";
  if ((ahead || info.phase === "open") && !info.recovery) return null;
  const plan = input.plan;
  const opened = plan && plan.openedAfter;
  return {
    phase: info.phase,
    race: info.race ? { date: info.race.date, km: info.race.km } : null,
    settled: info.settled ?? null,
    resultSec: info.resultSec ?? null,
    goalSec: Number(goalSec) > 0 ? Number(goalSec) : null,
    recoveryUntil: info.recovery ? info.recovery.until : null,
    openedAfter: opened && typeof opened.race === "string" ? { race: opened.race, km: Number(opened.km) || 0 } : null,
  };
}

// The RACE STATUS context line ("" for null): passed / result against the goal /
// not run, then the recovery still running and whether a next goal is chosen.
export function raceStatusLine(st) {
  if (!st) return "";
  const parts = [];
  if (st.phase === "open" || st.phase === "active" || st.phase === "raceWeek") {
    const o = st.openedAfter;
    parts.push(st.phase === "open"
      ? `open plan, no race${o ? ` (started after the ${o.km} km race on ${o.race})` : ""}`
      : `the plan opened after ${o ? `the ${o.km} km race on ${o.race}` : "a race"}`);
  } else {
    const race = `${st.race.km} km race on ${st.race.date}`;
    if (st.settled === "skipped") parts.push(`not run (the ${race} was skipped)`);
    else if (st.settled !== "done") parts.push(`passed, no result logged yet (the ${race})`);
    else if (st.resultSec == null) parts.push(`passed, run (the ${race}), no time logged`);
    else {
      const diff = st.goalSec ? Math.round(st.resultSec - st.goalSec) : null;
      const vs = diff == null ? "no goal time set"
        : diff === 0 ? `on the ${hms(st.goalSec)} goal`
          : `${hms(Math.abs(diff))} ${diff < 0 ? "under" : "over"} the ${hms(st.goalSec)} goal`;
      parts.push(`passed (the ${race}), result ${hms(st.resultSec)}, ${vs}`);
    }
  }
  if (st.recoveryUntil) parts.push(`easy running only through ${st.recoveryUntil}`);
  if (st.phase === "choosing" || st.phase === "recovery") parts.push("next goal not chosen yet");
  return `RACE STATUS: ${parts.join("; ")}.\n`;
}
