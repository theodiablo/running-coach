// What to say the moment a recording finishes: a headline drawn from a varied
// pool, plus at most one fact about THIS run measured against the runner's own
// log (never an absolute yardstick: one runner's slow day is another's record).
// Pure: the caller supplies randomness and the recently-shown keys.
// docs/run-celebration.md.

import copy from "../i18n/locales/en/celebration.json";
import { isPersonalBest, runAchievements, type EffortRank } from "./bestEfforts";
import { fmt, weekKey } from "./format";
import { buildSplits } from "./runSplits";
import { isCrossTraining, type PlanSession, type Run } from "../types";
import type { TrackPointOrGap } from "./geo";

type HeadPool = keyof typeof copy.head;
type FactFamily = keyof typeof copy.fact;

export type CelebrationFact = {
  key: string;
  vars: Record<string, string | number>;
  // 3 = a milestone (earns confetti), 2 = notable, 1 = nice to know.
  weight: 1 | 2 | 3;
};

export type Celebration = {
  headline: string;
  fact: CelebrationFact | null;
  efforts: EffortRank[];
  confetti: boolean;
  // Drawn from the rare pool: the screen says so.
  rare: boolean;
};

export type CelebrationInput = {
  // The run as it is about to be saved (no id yet).
  run: Run;
  // The log BEFORE this run.
  runs: Run[];
  points?: TrackPointOrGap[] | null;
  session?: PlanSession | null;
  // Local start time, for early/late headlines.
  at: Date;
  recent?: string[];
  rand?: () => number;
};

export const RARE_CHANCE = 0.01;
const MIN_HISTORY = 3;
const COMEBACK_DAYS = 14;
const RECENT_DAYS = 56;
const COUNT_MILESTONES = [10, 25, 50, 75, 100];
const KM_MILESTONES = [50, 100, 250, 500, 750, 1000];

const onFoot = (r: Run) => !isCrossTraining(r);
const running = (r: Run) => onFoot(r) && String(r.type).toUpperCase() !== "WALK";
const dayMs = 86400000;
const daysBetween = (a: string, b: string) =>
  Math.round((new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) / dayMs);
const km1 = (n: number) => String(Math.round(n * 10) / 10);
const maxOf = (xs: number[]) => xs.reduce((m, x) => (x > m ? x : m), 0);

// Too little to have been a real outing: an accidental Start, a test.
export function isNegligible(run: Run, indoor: boolean): boolean {
  const sec = run.durationSec || 0;
  return indoor ? sec < 60 : (run.km || 0) < 0.2 && sec < 120;
}

const isShort = (run: Run) => (run.km || 0) < 1 || (run.durationSec || 0) < 300;

const isCountMilestone = (n: number) => COUNT_MILESTONES.includes(n) || (n > 100 && n % 50 === 0);

// The lifetime-km mark this run carried the total across: the fixed ladder, then every 500.
function kmMilestone(before: number, after: number): number | null {
  for (const t of KM_MILESTONES) if (before < t && t <= after) return t;
  const t = Math.floor(after / 500) * 500;
  return t > KM_MILESTONES[KM_MILESTONES.length - 1] && before < t ? t : null;
}

// Second half quicker than the first, over whole kilometres. A split far slower
// than the rest is a stop (a pause leaves time without distance), so any such
// run makes no claim rather than a wrong one.
export function isNegativeSplit(points: TrackPointOrGap[]): boolean {
  const full = buildSplits(points).filter(s => s.distKm >= 0.999 && s.paceSecPerKm > 0);
  if (full.length < 4) return false;
  const paces = full.map(s => s.paceSecPerKm).sort((a, b) => a - b);
  const median = paces[Math.floor(paces.length / 2)];
  if (paces[paces.length - 1] > median * 1.5) return false;
  const n = Math.floor(full.length / 2);
  const avg = (ss: typeof full) => ss.reduce((s, x) => s + x.paceSecPerKm, 0) / ss.length;
  return avg(full.slice(-n)) <= avg(full.slice(0, n)) * 0.98;
}

function fact(family: FactFamily, weight: CelebrationFact["weight"], vars: CelebrationFact["vars"] = {}): CelebrationFact {
  return { key: family, vars, weight };
}

function comeback(run: Run, prior: Run[]): CelebrationFact | null {
  const last = prior.reduce<string | null>((m, r) => (r.date && (!m || r.date > m) ? r.date : m), null);
  if (!last) return null;
  const days = daysBetween(last, run.date);
  return days >= COMEBACK_DAYS ? fact("comeback", 2, { days }) : null;
}

function indoorFacts(run: Run, runs: Run[]): CelebrationFact[] {
  const out: CelebrationFact[] = [];
  const prior = runs.filter(isCrossTraining);
  const sec = run.durationSec || 0;
  if (!prior.length) out.push(fact("indoorFirst", 2));
  else if (prior.length >= MIN_HISTORY && sec >= 600 && sec > maxOf(prior.map(r => r.durationSec || 0)))
    out.push(fact("indoorLongest", 2, { dur: fmt.dur(sec) }));
  const back = comeback(run, runs);
  if (back) out.push(back);
  return out;
}

function runFacts(input: CelebrationInput): CelebrationFact[] {
  const { run, runs, points, session } = input;
  const prior = runs.filter(onFoot);
  if (!prior.length) return [fact("first", 3)];
  if (isShort(run)) return [];

  const out: CelebrationFact[] = [];
  const km = run.km || 0;
  const sec = run.durationSec || 0;

  const n = prior.length + 1;
  if (isCountMilestone(n)) out.push(fact("count", 3, { n }));

  const before = prior.reduce((s, r) => s + (Number(r.km) || 0), 0);
  const passed = kmMilestone(before, before + km);
  if (passed) out.push(fact("total", 3, { km: passed }));

  const ran = prior.filter(running);
  const enough = ran.length >= MIN_HISTORY;
  const longestKm = maxOf(ran.map(r => Number(r.km) || 0));
  const isLongest = enough && km >= 3 && km > longestKm;
  if (isLongest) out.push(fact("longest", 3, { km: km1(km) }));
  else if (enough && sec >= 1200 && sec > maxOf(ran.map(r => r.durationSec || 0)))
    out.push(fact("longestTime", 2, { dur: fmt.dur(sec) }));
  else if (enough && km >= 3) {
    const recent = ran.filter(r => r.date && daysBetween(r.date, run.date) <= RECENT_DAYS);
    if (recent.length >= MIN_HISTORY && km > maxOf(recent.map(r => Number(r.km) || 0)))
      out.push(fact("recentLongest", 1, { km: km1(km) }));
  }

  const elev = Number(run.elevation) || 0;
  const climbs = prior.map(r => Number(r.elevation) || 0).filter(e => e > 0);
  if (elev >= 50 && climbs.length >= MIN_HISTORY && elev > maxOf(climbs))
    out.push(fact("climb", 2, { m: Math.round(elev) }));

  const wk = weekKey(run.date);
  const weeks = new Map<string, number>();
  for (const r of prior) if (r.date) weeks.set(weekKey(r.date), (weeks.get(weekKey(r.date)) || 0) + (Number(r.km) || 0));
  const thisWeek = (weeks.get(wk) || 0) + km;
  weeks.delete(wk);
  if (weeks.size >= 4 && thisWeek > maxOf([...weeks.values()]))
    out.push(fact("week", 2, { km: km1(thisWeek) }));

  if (km > 0 && sec > 0) {
    const similar = ran.filter(r => r.km >= km * 0.75 && r.km <= km * 1.25 && (r.durationSec || 0) > 0).slice(0, 20);
    if (similar.length >= 5) {
      const paces = similar.map(r => (r.durationSec as number) / r.km).sort((a, b) => a - b);
      const median = paces[Math.floor(paces.length / 2)];
      const pace = sec / km;
      if (pace <= median * 0.97) out.push(fact("quicker", 1, { pace: fmt.pace(pace) }));
    }
  }

  if (points && km >= 4 && isNegativeSplit(points)) out.push(fact("negSplit", 1));

  const type = String(session?.type || "").toUpperCase();
  if (type in copy.fact.session) out.push(fact("session", type === "RACE" ? 3 : 1, { type }));

  const back = comeback(run, prior);
  if (back) out.push(back);
  return out;
}

// Every fact that holds for this run, unordered. Exported for tests.
export function celebrationFacts(input: CelebrationInput): CelebrationFact[] {
  return isCrossTraining(input.run) ? indoorFacts(input.run, input.runs) : runFacts(input);
}

// A random key from `keys`, skipping recently shown ones while any remain.
function pick(keys: string[], recent: string[], rand: () => number): string {
  const fresh = keys.filter(k => !recent.includes(k));
  const pool = fresh.length ? fresh : keys;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}

const headKeys = (pool: HeadPool) => Object.keys(copy.head[pool]).map(k => `celebration.head.${pool}.${k}`);

function factKey(f: CelebrationFact, recent: string[], rand: () => number): string {
  if (f.key === "session") return `celebration.fact.session.${f.vars.type}`;
  const variants = Object.keys(copy.fact[f.key as FactFamily]).map(k => `celebration.fact.${f.key}.${k}`);
  return pick(variants, recent, rand);
}

export function buildCelebration(input: CelebrationInput): Celebration | null {
  const { run, runs, at, recent = [], rand = Math.random } = input;
  const indoor = isCrossTraining(run);
  if (isNegligible(run, indoor)) return null;

  const efforts = indoor ? [] : runAchievements(run, runs);
  const pb = efforts.some(isPersonalBest);

  const facts = celebrationFacts(input);
  const top = Math.max(0, ...facts.map(f => f.weight));
  // The highest tier wins; within it, prefer a family not shown recently.
  const tier = facts.filter(f => f.weight === top);
  const unseen = tier.filter(f => !recent.some(k => k.startsWith(`celebration.fact.${f.key}.`)));
  const chosen = (unseen.length ? unseen : tier)[Math.floor(rand() * (unseen.length || tier.length))] ?? null;
  const fact = chosen ? { ...chosen, key: factKey(chosen, recent, rand) } : null;

  const hour = at.getHours();
  // A best effort's own headline outranks luck: it says what happened.
  const rare = !pb && rand() < RARE_CHANCE;
  let pool: HeadPool = rare ? "rare" : pb ? "pb" : indoor ? "indoor" : isShort(run) ? "short" : "run";
  if (pool === "run" && rand() < 0.5) {
    if (hour >= 4 && hour < 7) pool = "early";
    else if (hour >= 21 || hour < 4) pool = "night";
  }
  const headline = pick(headKeys(pool), recent, rand);

  return { headline, fact, efforts, confetti: rare || pb || fact?.weight === 3, rare };
}
