import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildPlan } from "./plan";
import { STYLE_IDS } from "./planStyles";
import { renderSd } from "./sessionDesc";
import { cleanDesc } from "./format";
// @ts-expect-error Shared edge-function ESM has no TypeScript declarations yet.
import { applyToolCall } from "../../supabase/functions/_shared/coach/tools.mjs";
import type { PlanSessionInput } from "./plan";

// The English-equivalence guarantee: for every session buildPlan stamps with a
// structured descriptor (`sd`), rendering it in English must reproduce the
// stored `desc` byte-for-byte. This is what lets us translate the sentence at
// render time while keeping `desc` the canonical fallback — if a template ever
// drifts from the generator, this fails instead of a snapshot silently changing.

const DAYS_3: PlanSessionInput[] = [
  { dayOffset: 1, minutes: 40 },
  { dayOffset: 3, minutes: 45 },
  { dayOffset: 6, minutes: 90 },
];
const DAYS_4: PlanSessionInput[] = [
  { dayOffset: 1, minutes: 30 },
  { dayOffset: 2, minutes: 40 },
  { dayOffset: 4, minutes: 45 },
  { dayOffset: 6, minutes: 90 },
];

describe("renderSd reproduces the English desc for every generated sd", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T10:00:00")); // a Wednesday
  });
  afterEach(() => vi.useRealTimers());

  const cases: [string, ReturnType<typeof buildPlan>][] = [];
  for (const style of STYLE_IDS) {
    for (const [label, distanceKm, goalSec, elev] of [
      ["10k", 10, 3000, 0],
      ["half", 21.1, 6340, 150],
      ["marathon", 42.2, 14400, 300],
    ] as const) {
      // plain plan
      cases.push([
        `${style} ${label}`,
        buildPlan("2026-11-29", goalSec, DAYS_3, distanceKm, elev, { style }),
      ]);
      // 4-day layout (exercises the adjacency demotion sweep)
      cases.push([
        `${style} ${label} 4-day`,
        buildPlan("2026-11-29", goalSec, DAYS_4, distanceKm, elev, { style }),
      ]);
      // with a secondary race in the window (race overlay + mini-taper)
      cases.push([
        `${style} ${label} +race`,
        buildPlan("2026-11-29", goalSec, DAYS_3, distanceKm, elev, {
          style,
          races: [{ editionId: "tuneup", date: "2026-09-20", distanceKm: 10, elevation: 40 }],
        }),
      ]);
    }
  }

  it.each(cases)("%s: every sd renders to its desc", (_label, plan) => {
    let checked = 0;
    for (const wk of plan.weeks) {
      for (const s of wk.sessions) {
        if (!s.sd) continue;
        checked++;
        expect(renderSd(s.sd, s)).toBe(cleanDesc(s.desc));
      }
    }
    // Guard against a vacuous pass if sd stops being emitted.
    expect(checked).toBeGreaterThan(0);
  });
});

// The same guarantee for COACH-authored sessions: swap/add/convert/recovery-week
// stamp `sd` via sdFor, which must render to the tool's English `desc`
// byte-for-byte — otherwise a coach edit shows a stale/mismatched sentence
// (the app renders `sd` in preference to `desc`). Drives the real tool path.
describe("renderSd reproduces the English desc for coach-authored sd", () => {
  // Pinned, like the generator matrix in coachValidation.test.ts: buildPlan
  // anchors week 1 on the next Monday off the real clock, so the hardcoded
  // mid-plan add date below drifts out of the plan window as the weeks pass
  // (it fell before week 1 and failed every style with OUT_OF_PLAN).
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T10:00:00"));
  });
  afterEach(() => vi.useRealTimers());

  const firstEditable = (plan: ReturnType<typeof buildPlan>) => {
    for (const w of plan.weeks) for (const s of w.sessions)
      if (s.type !== "RACE" && !s.done) return { id: s.id, week: w.weekNumber, date: s.date };
    throw new Error("no editable session");
  };

  for (const style of STYLE_IDS) {
    it(`${style}: swap/add/convert/recovery sd renders to its desc`, () => {
      const base = buildPlan("2026-11-29", 6340, [
        { dayOffset: 1, minutes: 40 }, { dayOffset: 3, minutes: 45 }, { dayOffset: 6, minutes: 90 },
      ], 21.1, 100, { style });
      const check = (plan: ReturnType<typeof buildPlan>) => {
        let n = 0;
        for (const w of plan.weeks) for (const s of w.sessions) {
          if (!s.sd) continue;
          n++;
          expect(renderSd(s.sd, s), `${style} ${s.type} ${JSON.stringify(s.sd)}`).toBe(cleanDesc(s.desc));
        }
        return n;
      };
      // swap to each allowed type
      for (const nt of ["EASY", "TEMPO", "INTERVALS", "LONG", "WALK"]) {
        const ed = firstEditable(base);
        check(applyToolCall(base, "swap_session", { session_id: ed.id, new_type: nt }));
      }
      // convert to cross-training + recovery week
      check(applyToolCall(base, "convert_to_cross_training", { session_id: firstEditable(base).id }));
      check(applyToolCall(base, "insert_recovery_week", { week_number: firstEditable(base).week }));
      // add a session (mid-plan date, safely before taper)
      const added = applyToolCall(base, "add_session", { date: "2026-09-16", type: "EASY", km: 5 });
      expect(check(added)).toBeGreaterThan(0);
    });
  }
});
