import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { buildPlan } from "./plan";
import { ymd } from "./format";
import { applySessionEdit, addSlot, canPlaceOn, defaultKm, editIssues, findSession, isEditableSession } from "./planEdit";
import { stylePacing } from "./planStyles";
import { runwalkRatio } from "./sessionSteps";
import { compileWorkout } from "./workout";
import type { Plan, PlanSession } from "../types";

const dayAfter = (s: string, n: number) => {
  const d = new Date(s + "T00:00:00");
  d.setDate(d.getDate() + n);
  return ymd(d);
};

const ANCHORS: [string, string][] = [
  ["monday anchor", "2026-09-14"],
  ["midweek anchor", "2026-09-16"],
];

describe.each(ANCHORS)("planEdit (%s)", (_label, anchor) => {
  beforeEach(() => { vi.setSystemTime(new Date(anchor + "T09:00:00")); });
  afterAll(() => { vi.useRealTimers(); });

  const RW = { runWalkRunSec: 90, runWalkWalkSec: 45 };
  const build = (style = "balanced"): Plan => buildPlan(dayAfter(anchor, 12 * 7), 6000, [
    { dayOffset: 1, minutes: 45 }, { dayOffset: 3, minutes: 45 }, { dayOffset: 6, minutes: 90 },
  ], 21.1, 0, { style, runWalk: RW }) as unknown as Plan;

  const sessions = (p: Plan) => p.weeks.flatMap(w => w.sessions);
  const weekOf = (p: Plan, id: string) => p.weeks.find(w => w.sessions.some(s => s.id === id))!;
  // A day in `week` with no session on it.
  const freeDay = (p: Plan, n: number) => {
    const w = p.weeks[n];
    const busy = new Set(w.sessions.map(s => s.date));
    return Array.from({ length: 7 }, (_, i) => dayAfter(w.startDate!, i)).find(d => !busy.has(d))!;
  };

  it("moves a session within its week, keeping its id and progress fields", () => {
    const p = build();
    const s = p.weeks[1].sessions[0];
    const to = freeDay(p, 1);
    const next = applySessionEdit(p, { kind: "update", sessionId: s.id, date: to, type: String(s.type), km: Number(s.km) }, anchor)!;
    const moved = findSession(next, s.id)!.session;
    expect(moved.date).toBe(to);
    expect(moved.done).toBe(false);
    expect(weekOf(next, s.id).weekNumber).toBe(p.weeks[1].weekNumber);
    const dates = weekOf(next, s.id).sessions.map(x => x.date);
    expect(dates).toEqual([...dates].sort());
    expect(p.weeks[1].sessions[0].date).toBe(s.date);
  });

  it("moves a session across weeks into the week that holds the new day", () => {
    const p = build();
    const s = p.weeks[1].sessions[0];
    const to = freeDay(p, 2);
    const next = applySessionEdit(p, { kind: "update", sessionId: s.id, date: to, type: String(s.type), km: Number(s.km) }, anchor)!;
    expect(weekOf(next, s.id).weekNumber).toBe(p.weeks[2].weekNumber);
    expect(next.weeks[1].sessions.some(x => x.id === s.id)).toBe(false);
    expect(editIssues(p, next, anchor).blocking).toEqual([]);
  });

  it("swaps two sessions' days", () => {
    const p = build();
    const [a, b] = p.weeks[1].sessions;
    const next = applySessionEdit(p, { kind: "update", sessionId: a.id, date: b.date, type: String(a.type), km: Number(a.km), swapWith: b.id }, anchor)!;
    expect(findSession(next, a.id)!.session.date).toBe(b.date);
    expect(findSession(next, b.id)!.session.date).toBe(a.date);
  });

  it("retypes with the style's pace and a fresh descriptor, never a stale one", () => {
    const p = build();
    const s = p.weeks[1].sessions.find(x => x.type === "EASY")!;
    const next = applySessionEdit(p, { kind: "update", sessionId: s.id, date: s.date, type: "TEMPO", km: 8 }, anchor)!;
    const t = findSession(next, s.id)!.session;
    expect(t.type).toBe("TEMPO");
    expect(t.km).toBe(8);
    expect(t.pace).toBe(Math.round(Number(p.targetPace) * stylePacing("balanced").tempo));
    expect(t.sd?.kind).toBe("tempo");
    expect(t.desc).toMatch(/^Tempo/);
  });

  it("resizes within bounds and refuses a distance outside them", () => {
    const p = build();
    const s = p.weeks[1].sessions[0];
    const base = { kind: "update" as const, sessionId: s.id, date: s.date, type: String(s.type) };
    expect(findSession(applySessionEdit(p, { ...base, km: 7.26 }, anchor)!, s.id)!.session.km).toBe(7.3);
    expect(applySessionEdit(p, { ...base, km: 0.5 }, anchor)).toBeNull();
    expect(applySessionEdit(p, { ...base, km: 41 }, anchor)).toBeNull();
    expect(applySessionEdit(p, { ...base, km: NaN }, anchor)).toBeNull();
  });

  it("adds sessions with unique ids in the right week, and deletes them", () => {
    const p = build();
    const day = freeDay(p, 2);
    const once = applySessionEdit(p, { kind: "add", date: day, type: "EASY", km: 5 }, anchor)!;
    const twice = applySessionEdit(once, { kind: "add", date: day, type: "WALK", km: 3 }, anchor)!;
    const added = weekOf(twice, `user-add-${day}`).sessions.filter(s => s.date === day);
    expect(added.map(s => s.id)).toEqual([`user-add-${day}`, `user-add-${day}-2`]);
    expect(weekOf(twice, `user-add-${day}`).weekNumber).toBe(p.weeks[2].weekNumber);
    expect(added[0]).toMatchObject({ type: "EASY", km: 5, done: false, runId: null });
    expect(editIssues(p, twice, anchor).blocking).toEqual([]);

    const gone = applySessionEdit(twice, { kind: "delete", sessionId: `user-add-${day}` }, anchor)!;
    expect(findSession(gone, `user-add-${day}`)).toBeNull();
    expect(sessions(gone)).toHaveLength(sessions(p).length + 1);
  });

  it("refuses a day already lived, on or after race day, or outside the plan", () => {
    const p = build();
    const s = p.weeks[1].sessions[0];
    const move = (date: string) => applySessionEdit(p, { kind: "update", sessionId: s.id, date, type: String(s.type), km: Number(s.km) }, anchor);
    expect(move(dayAfter(anchor, -1))).toBeNull();
    expect(move(String(p.raceDate))).toBeNull();
    expect(move(dayAfter(String(p.raceDate), 3))).toBeNull();
    expect(applySessionEdit(p, { kind: "add", date: String(p.raceDate), type: "EASY", km: 5 }, anchor)).toBeNull();
    expect(applySessionEdit(p, { kind: "add", date: freeDay(p, 1), type: "RACE", km: 5 }, anchor)).toBeNull();
  });

  it("leaves done, skipped and race sessions alone", () => {
    const p = build();
    const [a, b] = p.weeks[1].sessions;
    a.done = true;
    b.skipped = true;
    const race = sessions(p).find(s => s.type === "RACE")!;
    for (const s of [a, b, race] as PlanSession[]) {
      expect(isEditableSession(p, s.id, anchor)).toBe(false);
      expect(applySessionEdit(p, { kind: "delete", sessionId: s.id }, anchor)).toBeNull();
    }
  });

  it("keeps elapsed weeks read-only once they have been lived", () => {
    const p = build();
    const later = dayAfter(String(p.weeks[1].startDate), 7);
    vi.setSystemTime(new Date(later + "T09:00:00"));
    const old = p.weeks[0].sessions[0];
    expect(isEditableSession(p, old.id, later)).toBe(false);
    expect(canPlaceOn(p, dayAfter(later, -1), later)).toBe(false);
    expect(addSlot(p, p.weeks[0], later)).toBeNull();
    expect(isEditableSession(p, p.weeks[2].sessions[0].id, later)).toBe(true);
  });

  it("warns, never blocks, when an edit breaks a training rule", () => {
    const p = build();
    const w = p.weeks[2];
    const hard = w.sessions.find(s => s.type === "TEMPO" || s.type === "INTERVALS" || s.type === "LONG")!;
    const nextDay = dayAfter(hard.date, 1);
    const target = w.sessions.find(s => s.id !== hard.id && s.type === "EASY")!;
    const next = applySessionEdit(p, { kind: "update", sessionId: target.id, date: nextDay, type: "INTERVALS", km: Number(target.km) }, anchor);
    expect(next).not.toBeNull();
    const { warnings, blocking } = editIssues(p, next!, anchor);
    expect(blocking).toEqual([]);
    expect(warnings.map(i => i.code)).toContain("HARD_BACK_TO_BACK");
  });

  it("reports nothing for a harmless edit, and never re-reports what the plan already had", () => {
    const p = build();
    const s = p.weeks[1].sessions.find(x => x.type === "EASY")!;
    const shorter = applySessionEdit(p, { kind: "update", sessionId: s.id, date: s.date, type: "EASY", km: Math.max(1, Number(s.km) - 1) }, anchor)!;
    expect(editIssues(p, shorter, anchor)).toEqual({ warnings: [], blocking: [] });
  });

  it("finds a free day for a new session and sizes it off the week", () => {
    const p = build();
    const w = p.weeks[1];
    const day = addSlot(p, w, anchor)!;
    expect(w.sessions.some(s => s.date === day)).toBe(false);
    const easy = w.sessions.filter(s => s.type === "EASY").map(s => Number(s.km));
    if (easy.length) expect(easy).toContain(defaultKm(w, "EASY"));
    expect(defaultKm(null, "EASY")).toBe(5);
  });

  describe("on a Run/Walk plan", () => {
    const ratio = (s: PlanSession) => runwalkRatio(s, String(s.desc));

    it("keeps a session's own ratio when it is retyped", () => {
      const p = build("runwalk");
      const walk = p.weeks[2].sessions.find(x => x.type === "WALK")!;
      const next = applySessionEdit(p, { kind: "update", sessionId: walk.id, date: walk.date, type: "LONG", km: 8 }, anchor, { runWalk: RW })!;
      const long = findSession(next, walk.id)!.session;
      expect(ratio(long)).toEqual(ratio(walk));
      expect(long.sd).toMatchObject({ kind: "runwalk", variant: "long" });
      expect(compileWorkout(long)?.steps.some(st => st.kind === "run" && st.sec === ratio(walk)!.runSec)).toBe(true);
    });

    it("gives an added session its week's ratio, so it still guides", () => {
      const p = build("runwalk");
      const w = p.weeks[2];
      const day = freeDay(p, 2);
      const theirs = ratio(w.sessions.find(x => x.type === "WALK")!);
      const walk = findSession(applySessionEdit(p, { kind: "add", date: day, type: "WALK", km: 4 }, anchor, { runWalk: RW })!, `user-add-${day}`)!.session;
      expect(ratio(walk)).toEqual(theirs);
      expect(compileWorkout(walk)).not.toBeNull();
      const easy = findSession(applySessionEdit(p, { kind: "add", date: day, type: "EASY", km: 4 }, anchor, { runWalk: RW })!, `user-add-${day}`)!.session;
      expect(ratio(easy)).toEqual(theirs);
    });

    it("falls back to the runner's ceiling at that week's phase", () => {
      const p = build("runwalk");
      const w = p.weeks[0];
      for (const s of w.sessions) { s.sd = undefined; s.desc = "Run/walk"; }
      const next = applySessionEdit(p, { kind: "add", date: freeDay(p, 0), type: "WALK", km: 3 }, anchor, { runWalk: RW })!;
      const added = findSession(next, `user-add-${freeDay(p, 0)}`)!.session;
      expect(w.phase).toBe("BASE");
      expect(ratio(added)).toEqual({ runSec: 30, walkSec: 45 });
      expect(added.sd).not.toHaveProperty("runMin");
    });
  });
});
