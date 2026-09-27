// The runner's own plan edits: move/swap, retype, resize, add, delete. Unlike
// the coach's tools these never refuse on training grounds — `editIssues` runs
// the shared validator and the editor WARNS; only structural soundness is
// enforced here. Detail: docs/training-plan.md ("Manual edits").
// @ts-expect-error Shared Deno/Vitest ESM has no TypeScript declaration file.
import * as sharedTools from "../../supabase/functions/_shared/coach/tools.mjs";
// @ts-expect-error Shared Deno/Vitest ESM has no TypeScript declaration file.
import * as sharedWeeks from "../../supabase/functions/_shared/coach/weeks.mjs";
import { validatePlan } from "./coachValidation";
import { fmt } from "./format";
import { runWalkConfig, runwalkRunSec } from "./runwalk";
import { runwalkRatio, type RunWalkRatio } from "./sessionSteps";
import type { Plan, PlanSession, PlanWeek, SessionSd } from "../types";

type Shape = { pace: number | null; desc: string; sd: SessionSd };
const { sessionShapeFor } = sharedTools as { sessionShapeFor: (plan: Plan, type: string) => Shape };
const weeks = sharedWeeks as {
  addDays: (ymd: string, n: number) => string;
  isElapsedWeek: (w: unknown, today: string) => boolean;
};

export const EDIT_TYPES = ["EASY", "LONG", "TEMPO", "INTERVALS", "WALK"] as const;
// The validator's training ceiling (MAX_TRAINING_KM) is a structural error.
export const MIN_KM = 1;
export const MAX_KM = 40;

export type SessionEdit =
  | { kind: "update"; sessionId: string; date: string; type: string; km: number; swapWith?: string | null }
  | { kind: "add"; date: string; type: string; km: number }
  | { kind: "delete"; sessionId: string };

export type PlanIssue = {
  code: string;
  severity: "error" | "warn";
  message: string;
  weekNumber?: number;
  sessionId?: string;
  previousSessionType?: string;
  previousSessionDate?: string;
  sessionType?: string;
  sessionDate?: string;
  preexisting?: boolean;
};

// Rules whose breach would leave a plan the app can't read, not merely one a
// coach would argue with. The operations below can't produce them; this is the
// backstop that keeps a bug from saving one.
const STRUCTURAL = new Set(["MALFORMED", "DUPLICATE_ID", "OUT_OF_WEEK", "AFTER_RACE", "SESSION_TOO_LONG"]);

const round1 = (n: number) => Math.round(n * 10) / 10;
const kmOk = (km: number) => Number.isFinite(km) && km >= MIN_KM && km <= MAX_KM;
const dayGap = (a: string, b: string) =>
  Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000);

const inWeek = (w: PlanWeek, date: string) => {
  if (!w.startDate) return false;
  const off = dayGap(w.startDate, date);
  return off >= 0 && off < 7;
};

export function findSession(plan: Plan, id: string): { week: PlanWeek; session: PlanSession } | null {
  for (const week of plan.weeks) {
    const session = week.sessions.find(s => s.id === id);
    if (session) return { week, session };
  }
  return null;
}

// Elapsed weeks are the training record; done and skipped sessions are undone
// first; races belong to the goal and the races tab.
export function isEditableSession(plan: Plan, id: string, today: string): boolean {
  const hit = findSession(plan, id);
  if (!hit) return false;
  const { week, session: s } = hit;
  return !s.done && !s.skipped && s.type !== "RACE" && !weeks.isElapsedWeek(week, today);
}

// A day a session can be put on: not yet lived, before race day, inside a week.
export function canPlaceOn(plan: Plan, date: string, today: string): boolean {
  if (!date || date < today || date >= String(plan.raceDate || "")) return false;
  return plan.weeks.some(w => !weeks.isElapsedWeek(w, today) && inWeek(w, date));
}

export function weekOfDate(plan: Plan, date: string): PlanWeek | null {
  return plan.weeks.find(w => inWeek(w, date)) || null;
}

// The week can take a new session somewhere, and the first day it would land on
// (preferring a free one).
export function addSlot(plan: Plan, week: PlanWeek, today: string): string | null {
  if (!week.startDate) return null;
  const days = Array.from({ length: 7 }, (_, i) => weeks.addDays(week.startDate!, i))
    .filter(d => canPlaceOn(plan, d, today));
  if (!days.length) return null;
  const busy = new Set(week.sessions.filter(s => !s.skipped).map(s => s.date));
  return days.find(d => !busy.has(d)) ?? days[0];
}

const relocate = (plan: Plan, id: string, date: string) => {
  const hit = findSession(plan, id);
  const target = weekOfDate(plan, date);
  if (!hit || !target) return;
  hit.week.sessions = hit.week.sessions.filter(s => s.id !== id);
  hit.session.date = date;
  target.sessions.push(hit.session);
  target.sessions.sort((a, b) => a.date.localeCompare(b.date));
};

type EditOpts = { runWalk?: { runWalkRunSec?: number; runWalkWalkSec?: number } | null };

const ratioOf = (s: PlanSession | null | undefined): RunWalkRatio | null =>
  s ? runwalkRatio(s, String(s.desc || "")) : null;

// A run/walk session keeps real figures (its own ratio, else its week's, else the
// runner's ceiling at that phase) or it loses its sentence and guided schedule.
function shapeFor(p: Plan, type: string, week: PlanWeek, prior: PlanSession | null, opts: EditOpts): Shape {
  const shape = sessionShapeFor(p, type);
  if (shape.sd?.kind !== "runwalk") return shape;
  const cfg = runWalkConfig(opts.runWalk);
  const r = ratioOf(prior) ?? week.sessions.map(ratioOf).find(Boolean)
    ?? { runSec: runwalkRunSec(cfg, String(week.phase || "")), walkSec: cfg.walkSec };
  const long = type === "LONG";
  const variant = long ? "long" : week.phase === "TAPER" ? "shortTaper" : "short";
  const ratio = "run " + fmt.interval(r.runSec) + " / walk " + fmt.interval(r.walkSec);
  const whole = r.runSec % 60 === 0 && r.walkSec % 60 === 0;
  return {
    ...shape,
    desc: long ? "Long run/walk — " + ratio + ", conversational"
      : "Run/walk — " + ratio + ", " + (variant === "shortTaper" ? "short and relaxed" : "conversational"),
    sd: { kind: "runwalk", variant, runSec: r.runSec, walkSec: r.walkSec, ...(whole ? { runMin: r.runSec / 60, walkMin: r.walkSec / 60 } : {}) },
  };
}

// Returns a NEW plan, or null when the edit isn't one the plan can hold.
// opts.runWalk: the runner's run/walk settings, for a session with no ratio to copy.
export function applySessionEdit(plan: Plan, edit: SessionEdit, today: string, opts: EditOpts = {}): Plan | null {
  const p = structuredClone(plan);
  switch (edit.kind) {
    case "delete": {
      if (!isEditableSession(p, edit.sessionId, today)) return null;
      const { week } = findSession(p, edit.sessionId)!;
      week.sessions = week.sessions.filter(s => s.id !== edit.sessionId);
      return p;
    }
    case "update": {
      if (!isEditableSession(p, edit.sessionId, today) || !kmOk(edit.km)) return null;
      const { week: home, session: s } = findSession(p, edit.sessionId)!;
      const from = s.date;
      if (edit.type !== s.type) {
        if (!(EDIT_TYPES as readonly string[]).includes(edit.type)) return null;
        Object.assign(s, shapeFor(p, edit.type, weekOfDate(p, edit.date) ?? home, s, opts), { type: edit.type });
      }
      s.km = round1(edit.km);
      if (edit.date === from) return edit.swapWith ? null : p;
      if (!canPlaceOn(p, edit.date, today)) return null;
      if (edit.swapWith) {
        const other = findSession(p, edit.swapWith)?.session;
        if (!other || other.date !== edit.date || !isEditableSession(p, other.id, today) || !canPlaceOn(p, from, today)) return null;
        relocate(p, other.id, from);
      }
      relocate(p, s.id, edit.date);
      return p;
    }
    case "add": {
      if (!kmOk(edit.km) || !(EDIT_TYPES as readonly string[]).includes(edit.type) || !canPlaceOn(p, edit.date, today)) return null;
      const week = weekOfDate(p, edit.date)!;
      const ids = new Set(p.weeks.flatMap(w => w.sessions.map(s => s.id)));
      let id = `user-add-${edit.date}`;
      for (let n = 2; ids.has(id); n++) id = `user-add-${edit.date}-${n}`;
      const shape = shapeFor(p, edit.type, week, null, opts);
      week.sessions.push({ id, date: edit.date, type: edit.type, km: round1(edit.km), ...shape, pace: shape.pace as number, done: false, runId: null });
      week.sessions.sort((a, b) => a.date.localeCompare(b.date));
      return p;
    }
  }
}

const issueKey = (i: PlanIssue) => `${i.code}|${i.weekNumber ?? ""}|${i.sessionId ?? ""}`;

// What an edit newly breaks: validator errors the baseline didn't already have,
// plus new warnings. `blocking` is structural only; everything else is advice.
export function editIssues(before: Plan, after: Plan, today: string): { warnings: PlanIssue[]; blocking: PlanIssue[] } {
  const res = validatePlan(after, { baseline: before, today }) as { errors: PlanIssue[]; warnings: PlanIssue[] };
  const had = new Set((validatePlan(before, { today }).warnings as PlanIssue[]).map(issueKey));
  const fresh = [...res.errors, ...res.warnings.filter(w => !w.preexisting && !had.has(issueKey(w)))];
  return {
    blocking: fresh.filter(i => STRUCTURAL.has(i.code)),
    warnings: fresh.filter(i => !STRUCTURAL.has(i.code)),
  };
}

// A starting distance for a new session of `type`: that type's typical length in
// the week, else the week's typical session, else 5 km.
export function defaultKm(week: PlanWeek | null, type: string): number {
  const pool = (week?.sessions || []).filter(s => !s.skipped && s.type !== "RACE");
  const pick = pool.filter(s => s.type === type).length ? pool.filter(s => s.type === type) : pool.filter(s => s.type === "EASY");
  if (!pick.length) return 5;
  const kms = pick.map(s => Number(s.km)).sort((a, b) => a - b);
  return Math.min(MAX_KM, Math.max(MIN_KM, round1(kms[Math.floor(kms.length / 2)])));
}
