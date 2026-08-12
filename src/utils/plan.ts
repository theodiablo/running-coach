// Training-plan builder.
import { VERT_COST } from "../constants";
import { fmt, ymd } from "./format";
import {
  DEFAULT_STYLE, STYLE_SHAPE, isStyleId, levelStartLongKm, pickHardDays, stylePacing,
  type StyleId,
} from "./planStyles";
import { isCrossTraining } from "../types";
import type { Plan, PlanProgress, SessionSd } from "../types";

export type PlanSessionInput = { dayOffset: number; minutes: number };
type PlanSession = {
  id: string;
  date: string;
  type: string;
  desc: string;
  // Structured descriptor rendered per-locale by the UI (sessionDesc.ts).
  // `desc` stays the English canonical form for old clients and the coach model.
  sd?: SessionSd;
  km: number;
  pace: number;
  done: boolean;
  runId: string | null;
  editionId?: string | null;
};
type PlanWeek = { weekNumber: number; startDate: string; phase: string; sessions: PlanSession[] };
type RecentRun = { date?: string; km?: number };
type OverlayRace = { editionId: string; date: string; distanceKm: number; elevation?: number };
export type BuildPlanOptions = {
  recentRuns?: RecentRun[];
  races?: OverlayRace[];
  mainEditionId?: string | null;
  style?: string | null;
  // Self-reported training level — a fitness floor for the starting long run
  // when there's no recent run history (typically the very first plan).
  level?: string | null;
};
type BuiltPlan = {
  raceDate: unknown;
  goalSec: unknown;
  distanceKm: unknown;
  raceElevation: number;
  targetPace: number;
  racePace: number;
  longRunPeakKm: number;
  planSessions: PlanSessionInput[];
  style: StyleId;
  weeks: PlanWeek[];
};

// Everything a style's week composer needs from the buildPlan closure. One
// composer call fills one week's sessions (long run included) via `addS`.
type WeekCtx = {
  w: number;
  N: number;
  phase: string;
  isBase: boolean;
  isTaper: boolean;
  rampFrac: number; // 0→1 progress through the pre-taper ramp (long-run ramp)
  longSess: PlanSessionInput;
  qualSessions: PlanSessionInput[];
  longKm: number;
  addS: (dOff: number, type: string, km: number, desc: string, pace: number, sd: SessionSd) => void;
  paces: { easy: number; tmpo: number; intv: number; long: number; walk: number };
  tgt: number;
  dist: number;
};

// `opts` is additive so the positional call sites keep working. Every app call
// site must pass `style` — omitting it silently rebuilds as "balanced".
export function buildPlan(
  raceDate: unknown,
  goalSec: unknown,
  planSessions?: PlanSessionInput[],
  distanceKm?: unknown,
  raceElevation?: unknown,
  planOpts: BuildPlanOptions = {}
): BuiltPlan {
  if (!goalSec) goalSec = 7200;
  if (!distanceKm) distanceKm = 20;
  if (!planSessions?.length) planSessions = [{dayOffset:2,minutes:30},{dayOffset:6,minutes:60}];
  const goal = Number(goalSec);
  const dist = Number(distanceKm);
  const recentRuns = planOpts.recentRuns || [];
  const today = new Date(); today.setHours(0,0,0,0);
  const raceDateText = String(raceDate || "");
  const race  = new Date(raceDateText + "T00:00:00");
  const dow   = today.getDay();
  const toMon = dow === 1 ? 0 : dow === 0 ? 1 : (8 - dow) % 7;
  const w0    = new Date(today); w0.setDate(today.getDate() + toMon);
  const N     = Math.max(4, Math.min(24, Math.floor((race.getTime() - w0.getTime()) / 86400000 / 7)));
  // Training paces target the *flat-equivalent* effort: finishing a hilly course
  // in the goal time needs the flat fitness of a faster runner, so each metre of
  // climb stretches the effective distance (same VERT_COST grade-adjust as the
  // predictions). On a flat course this collapses to goalSec / distanceKm.
  const gain      = Number(raceElevation || 0);
  const flatEqDist = dist + VERT_COST * gain / 1000;
  const tgt       = Math.round(goal / flatEqDist);
  // Real average ground pace on the course — what the race-day card should show.
  const racePace = Math.round(goal / dist);
  // Methodology style: pace multipliers come from the shared table (also read
  // by the coach agent) so plan and coach edits can never drift; plan shape
  // comes from STYLE_SHAPE. Absent/unknown style = "balanced" = the pre-styles
  // algorithm, byte-identical (its multipliers are the old hardcoded ratios).
  const style: StyleId = isStyleId(planOpts.style) ? planOpts.style : DEFAULT_STYLE;
  const pacing = stylePacing(style);
  const shape = STYLE_SHAPE[style];
  const easy  = Math.round(tgt * pacing.easy);
  const tmpo  = Math.round(tgt * pacing.tempo);
  const intv  = Math.round(tgt * pacing.intervals);
  const longP = Math.round(tgt * pacing.long);
  // Only styles that treat WALK as a real run/walk session carry a walk
  // multiplier; the easy fallback is never used by composers of other styles.
  const walkP = Math.round(tgt * (pacing.walk ?? pacing.easy));
  const sorted = planSessions.slice().sort((a, b) => b.minutes - a.minutes);
  const longSess = sorted[0];
  const qualSessions = sorted.slice(1);

  // Peak long-run distance is driven by the RACE distance, not the session time
  // budget — you can't train for 20 km on 60-min long runs. ~0.9x for short/half
  // races; the marathon is run a bit short in training; everything is hard-capped
  // so an ultra (UTMB 171 km) can't generate an absurd long run. The session
  // `minutes` no longer caps the long run (it still informs the shown duration and
  // the quality-session sizing) — see PlanView's long-run nudge.
  // (Estimated weekly km at easy pace from the configured minutes — lets a
  // style cap the long run as a share of weekly volume, e.g. Hansons.)
  const estWeeklyKm = planSessions.reduce((s, q) => s + q.minutes * 60 / easy, 0);
  const peakLong = shape.peakLong(dist, estWeeklyKm);

  // Fitness-aware floor (a generation-time snapshot). The longest run in the last
  // ~5 weeks sets a starting long run so a fit athlete isn't sent back to square
  // one — but never above the race-scaled peak (don't inflate a 10 km block off
  // big long runs). Empty recentRuns → 0 floor → today's gentle default start.
  const RECENT_MS = 35 * 86400000;
  const cutoff = ymd(new Date(today.getTime() - RECENT_MS));
  const longestRecent = recentRuns.reduce(
    (m, r) => (r && r.date && r.date >= cutoff && (r.km ?? 0) > 0 ? Math.max(m, r.km ?? 0) : m), 0);
  const fitFloor = Math.min(longestRecent * 0.8, peakLong);
  // Self-reported level (onboarding) plays the same role as a recent long run
  // when there's no history yet; real logged runs dominate via fitFloor.
  const levelFloor = Math.min(levelStartLongKm(planOpts.level), peakLong);
  // Long run ramps linearly from this start to the peak over the pre-taper weeks.
  const startLong = Math.max(shape.floorKm, fitFloor, levelFloor);
  const lastBuildW = N - 4; // 0-based index of the final pre-taper week (peak hits here)

  const weeks: PlanWeek[] = [];

  for (let w = 0; w < N; w++) {
    const wS = new Date(w0); wS.setDate(w0.getDate() + w * 7);
    const isTaper = w >= N - 3;
    const isPeak  = w >= N - 7 && !isTaper;
    const isBase  = w < 4;
    const phase   = isTaper ? "TAPER" : isPeak ? "PEAK" : isBase ? "BASE" : "BUILD";
    const ss: PlanSession[] = [];

    const addS = (dOff: number, type: string, km: number, desc: string, pace: number, sd: SessionSd) => {
      const d = new Date(wS); d.setDate(wS.getDate() + dOff);
      if (d >= race) return;
      ss.push({
        id: "w" + (w+1) + "d" + dOff,
        date: ymd(d),
        type, desc, sd,
        km: Math.round(Math.max(1.5, km) * 10) / 10,
        pace, done: false, runId: null,
      });
    };

    const rampFrac = lastBuildW > 0 ? Math.min(1, w / lastBuildW) : 1;
    let longKm;
    if (isTaper) {
      // Taper long runs scale off the peak — shed volume, keep some endurance.
      const taperIdx = w - (N - 3);
      const taperMults = shape.taperMults;
      longKm = peakLong * (taperMults[taperIdx] !== undefined ? taperMults[taperIdx] : taperMults[2]);
    } else {
      // Ramp from the fitness-aware start to the race-scaled peak across the
      // pre-taper weeks (peak reached at the last build/peak week).
      longKm = startLong + (peakLong - startLong) * rampFrac;
      // Galloway-style cutback: every 3rd ramp week sheds ~30% (never the peak
      // week). Down-weeks are ramp-safe — the validator only limits increases.
      if (shape.cutbackEvery3 && w % 3 === 2 && w !== lastBuildW) longKm *= 0.7;
    }

    COMPOSERS[style]({
      w, N, phase, isBase, isTaper, rampFrac, longSess, qualSessions, longKm,
      addS, paces: { easy, tmpo, intv, long: longP, walk: walkP }, tgt, dist,
    });

    ss.sort((a, b) => a.date.localeCompare(b.date));
    weeks.push({weekNumber: w+1, startDate: ymd(wS), phase, sessions: ss});
  }

  // Belt-and-braces hard-day spacing for the styled composers: demote the
  // lower-priority of any two hard-typed sessions on consecutive days to EASY
  // (LONG > TEMPO > INTERVALS; on a tie the later one gives way). Catches
  // whatever pickHardDays couldn't place cleanly, including the week wrap.
  // Balanced is exempt on purpose — its output predates styles and a
  // user-picked back-to-back day pair is a pre-existing, validator-waived
  // condition we must not silently rewrite.
  if (style !== DEFAULT_STYLE) {
    const HARD_PRIO: Record<string, number> = { LONG: 3, TEMPO: 2, INTERVALS: 1 };
    const all = weeks.flatMap(wk => wk.sessions)
      .filter(s => HARD_PRIO[s.type])
      .sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1], cur = all[i];
      if (!HARD_PRIO[prev.type] || !HARD_PRIO[cur.type]) continue;
      const gapDays = (new Date(cur.date + "T00:00:00").getTime()
        - new Date(prev.date + "T00:00:00").getTime()) / 86400000;
      if (gapDays > 1) continue;
      const demote = HARD_PRIO[cur.type] > HARD_PRIO[prev.type] ? prev : cur;
      demote.type = "EASY";
      demote.pace = easy;
      demote.desc = "Easy run — relaxed aerobic effort";
      demote.sd = { kind: "easy", variant: "relaxed" };
    }
  }

  // ── Secondary-race overlay ────────────────────────────────────────────────
  // Drop any user-added races that fall inside the plan window onto their week as
  // RACE sessions. The plan still peaks/tapers for the *main* race — these are
  // extra checkpoints. Pace is a Riegel estimate off the main goal and never
  // feeds back into the prescribed training paces. Phase 3 adds taper/recovery
  // around them. `opts.races`: [{editionId, date, distanceKm, elevation}].
  const MIN_GAP_MS = 7 * 86400000; // keep a hard race out of the final taper days
  const seenDates = new Set<string>();
  (planOpts.races || []).forEach(r => {
    if (!r || !r.date || !r.distanceKm) return;
    const d = new Date(r.date + "T00:00:00");
    if (d < w0 || d >= race) return;          // outside the plan window
    if (race.getTime() - d.getTime() < MIN_GAP_MS) return;        // too close to the main race
    if (seenDates.has(r.date)) return;        // one race per date
    const wi = Math.floor((d.getTime() - w0.getTime()) / (7 * 86400000));
    if (wi < 0 || wi >= weeks.length) return;
    seenDates.add(r.date);
    const secKm = r.distanceKm;
    // Riegel projection of the main goal to this distance (t2 = t1·(d2/d1)^1.06).
    const secPace = Math.round(goal * Math.pow(secKm / dist, 1.06) / secKm);
    const secElev = (r.elevation ?? 0) > 0 ? Math.round(r.elevation ?? 0) : 0;
    const session: PlanSession = {
      id: "race-" + (r.editionId || r.date), date: r.date, type: "RACE",
      desc: "Race — " + secKm + "km" + (secElev > 0 ? " · +" + secElev + "m" : ""),
      sd: { kind: "race", km: secKm, ...(secElev > 0 ? { elevM: secElev } : {}) },
      km: secKm, pace: secPace, done: false, runId: null, editionId: r.editionId || null,
    };
    const wk = weeks[wi];
    if (!wk) return;
    // Replace a same-day training session if one exists, else add an extra one.
    const same = wk.sessions.findIndex(s => s.date === r.date);
    if (same >= 0) wk.sessions[same] = session;
    else wk.sessions.push(session);
    // Automatic, distance-scaled treatment (the user picks nothing): a substantial
    // race (≥ half the main distance) gets a mini-taper — ease the rest of that
    // week to recovery so we don't stack hard quality around it. A small race
    // (e.g. a 5 km before a marathon) just drops in.
    if (secKm >= 0.5 * dist) {
      wk.sessions = wk.sessions.map(s => s.type === "RACE" ? s : {
        ...s, type: "EASY", pace: easy,
        km: Math.round(Math.min(Number(s.km), 6) * 10) / 10,
        desc: "Easy run — keep it light around your race",
        sd: { kind: "easy", variant: "aroundRace" } as SessionSd,
      });
    }
    wk.sessions.sort((a, b) => a.date.localeCompare(b.date));
  });

  const rWS = new Date(w0); rWS.setDate(w0.getDate() + N * 7);
  weeks.push({
    weekNumber: N + 1,
    startDate: ymd(rWS),
    phase: "RACE",
    sessions: [{
      id: "race", date: raceDateText, type: "RACE",
      desc: "Race Day — " + distanceKm + "km"
        + (gain > 0 ? " · +" + Math.round(gain) + "m climb" : "")
        + "! Everything you trained for.",
      sd: { kind: "raceday", km: dist, ...(gain > 0 ? { elevM: Math.round(gain) } : {}) },
      km: dist, pace: racePace, done: false, runId: null,
      // Stamp the main race so multi-race detection reads all RACE sessions
      // uniformly off the plan. Null for a hand-entered (non-catalogue) target,
      // which then stays un-detected, exactly as before.
      editionId: planOpts.mainEditionId ?? null,
    }],
  });
  return {raceDate, goalSec, distanceKm, raceElevation: gain, targetPace: tgt, racePace,
    longRunPeakKm: Math.round(peakLong * 10) / 10, planSessions, style, weeks};
}

// ── Style week composers ─────────────────────────────────────────────────────
// One function per style fills a week's sessions (long run + the other days).
// `balanced` is the pre-styles loop body moved verbatim (frozen by snapshot
// tests); the others express their methodology while staying inside the shared
// validator envelope: hard days spaced by pickHardDays (+ the sweep above),
// gentle week-over-week growth, no tempo/intervals generated into the taper.

function composeBalanced(c: WeekCtx) {
  const { w, N, isBase, isTaper, addS, tgt } = c;
  const { easy, tmpo } = c.paces;
  addS(c.longSess.dayOffset, "LONG", c.longKm,
    "Long run — easy effort at " + fmt.pace(easy) + "/km", easy,
    { kind: "long", variant: "easy" });

  c.qualSessions.forEach(q => {
    const maxQ = q.minutes * 60 / easy;
    let type, desc, pace, km, sd: SessionSd;
    if (isBase || isTaper) {
      const easyKm = isBase ? 2.5 + w * 0.2 : Math.max(2, 4 - (w - (N - 3)) * 0.5);
      type = "EASY"; pace = easy;
      km   = Math.min(maxQ, easyKm);
      desc = "Easy run — relaxed aerobic effort";
      sd   = { kind: "easy", variant: "relaxed" };
    } else {
      const buildW = w - 4;
      if (buildW % 2 === 0) {
        type = "TEMPO"; pace = tmpo;
        km   = Math.min(maxQ * 0.85, q.minutes * 60 / tmpo * 0.8);
        desc = "Tempo run — " + fmt.pace(tmpo) + "/km, comfortably hard";
        sd   = { kind: "tempo", variant: "comfortablyHard" };
      } else {
        // Reps derive from the day's time budget, and the total distance is
        // computed FROM the reps (plus a 1.5 km warmup/recovery allowance) —
        // never clipped after the fact, so the description and the shown km
        // always agree. A short day honestly gets fewer reps.
        const reps = Math.max(3, Math.min(5, Math.floor((maxQ * 0.85 - 1.5) / 0.8)));
        type = "INTERVALS"; pace = tgt;
        km   = reps * 0.8 + 1.5;
        desc = "Intervals — " + reps + "x800m at " + fmt.pace(tgt) + "/km + 90s recovery";
        sd   = { kind: "intervals", variant: "standard", reps, repM: 800, recover: "90s" };
      }
    }
    addS(q.dayOffset, type, km, desc, pace, sd);
  });
}

// 80/20: one genuinely hard session a week (alternating tempo/intervals, a
// notch harder than balanced), everything else — long run included — slower
// and truly easy. The hard slot goes to the quality day farthest from the
// long run so the week breathes.
function composePolarized(c: WeekCtx) {
  const { w, N, isBase, isTaper, addS } = c;
  const { easy, tmpo, intv, long } = c.paces;
  addS(c.longSess.dayOffset, "LONG", c.longKm,
    "Long run — easy effort at " + fmt.pace(long) + "/km", long,
    { kind: "long", variant: "easy" });

  const hardDay = pickHardDays(
    c.qualSessions.map(q => q.dayOffset), c.longSess.dayOffset, 1)[0];

  c.qualSessions.forEach(q => {
    const maxQ = q.minutes * 60 / easy;
    if (isBase || isTaper || q.dayOffset !== hardDay) {
      // Build-phase easy days keep the base-phase growth line (+0.3/wk from
      // the same 2.5 start) so the week-5 hard session lands on top of a
      // smooth easy-volume curve instead of a step — the ramp rule's margin
      // is thinnest exactly at that transition.
      const easyKm = isBase ? 2.5 + w * 0.2
        : isTaper ? Math.max(2, 4 - (w - (N - 3)) * 0.5)
        : 2.5 + w * 0.3;
      addS(q.dayOffset, "EASY", Math.min(maxQ, easyKm),
        "Easy run — relaxed, conversational pace", easy,
        { kind: "easy", variant: "conversational" });
      return;
    }
    const buildW = w - 4;
    if (buildW % 2 === 0) {
      addS(q.dayOffset, "TEMPO",
        Math.min(maxQ * 0.85, q.minutes * 60 / tmpo * 0.8),
        "Tempo run — " + fmt.pace(tmpo) + "/km, your one hard session this week", tmpo,
        { kind: "tempo", variant: "oneHard" });
    } else {
      // Budget-derived reps; total = reps + allowance (see composeBalanced).
      const reps = Math.max(3, Math.min(5, Math.floor((maxQ * 0.85 - 1.5) / 0.8)));
      addS(q.dayOffset, "INTERVALS", reps * 0.8 + 1.5,
        "Intervals — " + reps + "x800m at " + fmt.pace(intv) + "/km + 90s jog recovery", intv,
        { kind: "intervals", variant: "standard", reps, repM: 800, recover: "90sJog" });
    }
  });
}

// Galloway run/walk: scheduled walk breaks from day one, no speedwork, gentle
// ramp with regular cutback weeks. Non-long days are WALK-typed (not "hard")
// so any day layout is valid.
function composeRunwalk(c: WeekCtx) {
  const { w, N, phase, isTaper, addS } = c;
  const { long, walk } = c.paces;
  // Ratio progresses with fitness, then BACKS OFF for the taper — its job is
  // shedding fatigue, so it must never be the plan's hardest ratio.
  const runMin = phase === "BASE" ? 1 : phase === "TAPER" ? 2 : phase === "BUILD" ? 2 : 3;
  addS(c.longSess.dayOffset, "LONG", c.longKm,
    "Long run/walk — run " + runMin + " min / walk 1 min, conversational", long,
    { kind: "runwalk", variant: "long", runMin, walkMin: 1 });

  c.qualSessions.forEach(q => {
    const km = isTaper
      ? Math.max(2, 4 - (w - (N - 3)) * 0.5)
      : Math.min(q.minutes * 60 / walk, 2.5 + w * 0.25);
    addS(q.dayOffset, "WALK", km,
      "Run/walk — run " + runMin + " min / walk 1 min, "
        + (isTaper ? "short and relaxed" : "conversational"), walk,
      { kind: "runwalk", variant: isTaper ? "shortTaper" : "short", runMin, walkMin: 1 });
  });
}

// FIRST-style "3 quality runs": long + intervals + tempo, all pace-prescribed
// and a notch faster; any further configured days become optional low-impact
// cross-training (OTHER — deliberately constant volume, so it never drives
// the weekly ramp). With <3 days it degrades: 2 days = long + alternating
// quality; 1 day = long only.
function composeLowfreq(c: WeekCtx) {
  const { w, N, isBase, isTaper, addS } = c;
  const { easy, tmpo, intv, long } = c.paces;
  addS(c.longSess.dayOffset, "LONG", c.longKm,
    "Long run — steady effort at " + fmt.pace(long) + "/km", long,
    { kind: "long", variant: "steady" });

  const hardDays = pickHardDays(
    c.qualSessions.map(q => q.dayOffset), c.longSess.dayOffset, 2);

  c.qualSessions.forEach(q => {
    const maxQ = q.minutes * 60 / easy;
    const slot = hardDays.indexOf(q.dayOffset);
    if (slot === -1) {
      // Extra day beyond the three key runs: optional cross-training. The km
      // figure is an easy-run-equivalent effort, kept flat week to week (only
      // the taper shrinks it, so TAPER_VOLUME still sees a real drop).
      const baseKm = Math.max(1.5, maxQ * 0.5);
      const km = isTaper ? baseKm * [0.85, 0.65, 0.45][Math.min(w - (N - 3), 2)] : baseKm;
      addS(q.dayOffset, "OTHER", km,
        "Optional cross-training — " + fmt.mins(q.minutes)
          + " easy bike, swim or elliptical (skip if tired)", easy,
        { kind: "cross", minutes: q.minutes });
      return;
    }
    if (isBase || isTaper) {
      const easyKm = isBase ? 2.5 + w * 0.2 : Math.max(2, 4 - (w - (N - 3)) * 0.5);
      addS(q.dayOffset, "EASY", Math.min(maxQ, easyKm),
        "Easy run — relaxed aerobic effort", easy,
        { kind: "easy", variant: "relaxed" });
      return;
    }
    const buildW = w - 4;
    // Two placed quality days: first = intervals, second = tempo. If only one
    // could be placed, it alternates so both stimuli still appear.
    const doIntervals = hardDays.length >= 2 ? slot === 0 : buildW % 2 === 1;
    if (doIntervals) {
      // Budget-derived reps; total = reps + allowance (see composeBalanced).
      const nominal = q.minutes <= 30 ? 6 : q.minutes <= 45 ? 5 : 6;
      const repKm   = q.minutes <= 30 ? 0.4 : q.minutes <= 45 ? 0.8 : 1;
      const reps = Math.max(3, Math.min(nominal, Math.floor((maxQ * 0.85 - 1.5) / repKm)));
      addS(q.dayOffset, "INTERVALS", reps * repKm + 1.5,
        "Intervals — " + reps + "x" + (repKm < 1 ? repKm * 1000 + "m" : "1km")
          + " at " + fmt.pace(intv) + "/km + recovery jogs", intv,
        { kind: "intervals", variant: "standard", reps, repM: repKm * 1000, recover: "jogs" });
    } else {
      addS(q.dayOffset, "TEMPO",
        Math.min(maxQ * 0.85, q.minutes * 60 / tmpo * 0.8),
        "Tempo run — " + fmt.pace(tmpo) + "/km, strong and controlled", tmpo,
        { kind: "tempo", variant: "strong" });
    }
  });
}

// Hansons-style cumulative fatigue: a capped, steady long run; two spaced
// "something of substance" days (speed/strength intervals + a goal-pace tempo
// that grows with the ramp); every other day moderate easy volume that fills
// most of its time budget — frequency over single-session heroics.
function composeHansons(c: WeekCtx) {
  const { w, N, phase, isBase, isTaper, rampFrac, addS, dist } = c;
  const { easy, tmpo, intv, long } = c.paces;
  addS(c.longSess.dayOffset, "LONG", c.longKm,
    "Long run — steady, moderate effort at " + fmt.pace(long) + "/km", long,
    { kind: "long", variant: "steadyModerate" });

  const sosDays = pickHardDays(
    c.qualSessions.map(q => q.dayOffset), c.longSess.dayOffset, 2);

  c.qualSessions.forEach(q => {
    const maxQ = q.minutes * 60 / easy;
    const slot = sosDays.indexOf(q.dayOffset);
    // Easy volume ramps from a gentle start toward ~90% of the day's budget,
    // in step with the long-run ramp so weekly growth stays inside the 1.3x
    // ramp rule.
    const easyFill = Math.min(maxQ * 0.9, 3 + Math.max(0, maxQ * 0.9 - 3) * rampFrac);

    if (isTaper) {
      // First taper week keeps one short goal-pace tempo (its dates are ≥15
      // days out — clear of the validator's 7-day no-tempo window); the final
      // two weeks are all easy.
      if (slot === 1 && w === N - 3) {
        addS(q.dayOffset, "TEMPO", Math.min(maxQ * 0.85, 5),
          "Tempo — short, at goal race pace " + fmt.pace(tmpo) + "/km", tmpo,
          { kind: "tempo", variant: "goalPaceShort" });
      } else {
        addS(q.dayOffset, "EASY", Math.min(maxQ, Math.max(2, 4 - (w - (N - 3)) * 0.5)),
          "Easy run — relaxed aerobic effort", easy,
          { kind: "easy", variant: "relaxed" });
      }
      return;
    }
    if (isBase || slot === -1) {
      addS(q.dayOffset, "EASY", easyFill, "Easy run — relaxed aerobic effort", easy,
        { kind: "easy", variant: "relaxed" });
      return;
    }
    if (slot === 0) {
      // Speed early, strength (near goal pace) once the peak phase starts.
      // Reps/sets derive from the day's budget so desc and km agree.
      if (phase === "PEAK") {
        const sets = maxQ * 0.85 >= 10 ? 3 : 2;
        addS(q.dayOffset, "INTERVALS", sets * 3 + 1,
          "Strength — " + sets + "x3km at goal pace minus 10s (" + fmt.pace(Math.max(1, tmpo - 10))
            + "/km) + 1km jog recovery", Math.max(1, tmpo - 10),
          { kind: "intervals", variant: "strength", reps: sets, repM: 3000, recover: "1kmJog", offsetSec: 10 });
      } else {
        const reps = Math.max(4, Math.min(8, Math.floor((maxQ * 0.85 - 1.5) / 0.6)));
        addS(q.dayOffset, "INTERVALS", reps * 0.6 + 1.5,
          "Speed — " + reps + "x600m at " + fmt.pace(intv) + "/km + 90s jog recovery", intv,
          { kind: "intervals", variant: "speed", reps, repM: 600, recover: "90sJog" });
      }
    } else {
      // The signature Hansons tempo: goal race pace, growing with the ramp,
      // capped at ~30% of race distance and the day's time budget.
      const tempoTarget = Math.min(q.minutes * 60 / tmpo * 0.85, 0.3 * dist);
      const km = Math.min(tempoTarget, 6 + Math.max(0, tempoTarget - 6) * rampFrac);
      addS(q.dayOffset, "TEMPO", km,
        "Tempo — at goal race pace " + fmt.pace(tmpo) + "/km, steady", tmpo,
        { kind: "tempo", variant: "goalPace" });
    }
  });
}

const COMPOSERS: Record<StyleId, (c: WeekCtx) => void> = {
  balanced: composeBalanced,
  polarized: composePolarized,
  runwalk: composeRunwalk,
  lowfreq: composeLowfreq,
  hansons: composeHansons,
};

type OpenSessionPlan = {
  weeks?: { weekNumber: number; sessions?: { id: string; date: string; type?: string; done?: boolean; skipped?: boolean }[] }[];
};

// Prefill for logging a plan session by hand (the plan row's and the
// dashboard's "Record" buttons, which open the manual form rather than a
// recorder).
//
// A cross-training session's `km` is SYNTHETIC — buildPlan gives it an
// easy-run-equivalent distance only because the coach validator rejects
// km <= 0 — so passing it through would save a number nobody covered as real
// running distance, contaminating volume, pace and PBs. Its *duration* is the
// real prescription, so prefill that instead. See docs/indoor-sessions.md.
export function planSessionPrefill(
  s: { id: string; date: string; type: string; km?: number | string; pace?: number; sd?: SessionSd },
  wNum: number,
) {
  const base = { date: s.date, type: s.type, wNum, sId: s.id };
  if (!isCrossTraining(s))
    return { ...base, km: Number(s.km), pace: s.pace };
  return { ...base, ...(s.sd?.minutes ? { durationSec: s.sd.minutes * 60 } : {}) };
}

// First not-done, not-skipped, non-RACE session on a given date, so a run logged
// for that day (watch import, GPS save) can auto-tick the matching plan session
// via LogView's onSaved. Returns {wNum, sId} or null. Pure.
//
// `opts.crossTraining` keeps a save from ticking off the wrong kind of session
// on a day that has both: an indoor bike session passes true so it can only
// reach the cross-training day, a run passes false so it can only reach the
// running one. Omitted = either (the import-review toast, which doesn't know
// which it has). See docs/indoor-sessions.md.
export function findOpenPlanSession(
  plan: OpenSessionPlan | null | undefined,
  date: string,
  opts: { crossTraining?: boolean } = {},
): { wNum: number; sId: string } | null {
  if (!plan?.weeks || !date) return null;
  for (const w of plan.weeks) {
    for (const s of w.sessions || []) {
      if (s.date !== date || s.type === "RACE" || s.done || s.skipped) continue;
      if (opts.crossTraining != null && isCrossTraining(s) !== opts.crossTraining) continue;
      return { wNum: w.weekNumber, sId: s.id };
    }
  }
  return null;
}

// Re-apply done/skipped/runId from an old plan onto a freshly built one by
// session id (ids are stable: w{n}d{dOff} for training, race-{editionId} for
// races). Lets a rebuild (availability edit, race add/remove, coach apply)
// keep weeks of progress. Pure.
export function carryProgress(oldPlan: Plan | null, np: Plan): Plan {
  if (!oldPlan) return np;
  const flags: Record<string, PlanProgress> = {};
  oldPlan.weeks.forEach(w => w.sessions.forEach(s => {
    flags[s.id] = { done: s.done, skipped: s.skipped, runId: s.runId };
  }));
  return { ...np, weeks: np.weeks.map(w => ({ ...w,
    sessions: w.sessions.map(s => {
      const f = flags[s.id];
      if (!f) return s;
      // skipped is a union, not an overwrite: the coach's cancel_session
      // marks skipped on the PROPOSAL, which must survive this re-stamp
      // (and a session the user skipped while the chat was open survives
      // the coach plan). done/runId stay client-owned overwrites.
      return { ...s, ...f, skipped: f.skipped || s.skipped };
    }) })) };
}
