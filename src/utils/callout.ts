// Audio-guidance status callouts (docs/guided-workouts.md): WHEN to speak and
// WHAT goes in the sentence. Pure and i18n-free; the hook renders the words.
// WorkoutGuidePlugin.kt mirrors calloutDue / the HR warning for screen-off
// Android — change both together.

import { hrOver, paceVerdict, type PaceVerdict, type WorkoutStep } from "./workout";

export type CalloutFreq = 30 | 60 | 90 | 120 | "km";
export type HrWarn = "off" | 0 | 5;
export type CalloutParts = { pace: boolean; hr: boolean; dist: boolean; left: boolean };

/** Synced preference (settings.audioGuide): how the coach talks, never what the run is. */
export type AudioPrefs = {
  freq: CalloutFreq;
  /** ± sec/km that still counts as on pace. */
  band: number;
  /** Warn when HR passes the zone top by this many bpm; "off" = never. */
  hrWarn: HrWarn;
  say: CalloutParts;
  /** Whether a run with no plan session starts with guidance on. */
  freeOn: boolean;
};

export const CALLOUT_FREQS: CalloutFreq[] = [30, 60, 90, 120, "km"];
export const HR_WARNS: HrWarn[] = ["off", 0, 5];
export const BAND_MIN = 5;
export const BAND_MAX = 30;

export const DEFAULT_AUDIO: AudioPrefs = {
  freq: 60, band: 10, hrWarn: 0,
  say: { pace: true, hr: true, dist: false, left: true },
  freeOn: false,
};

// GPS pace needs a stretch to settle after a step change before it's worth a verdict.
export const CALLOUT_MIN_INTO_STEP_SEC = 20;
export const HR_WARN_EVERY_SEC = 45;

/** Sanitized read of the synced blob — anything malformed falls back to the default. */
export function readAudioPrefs(raw: unknown): AudioPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<AudioPrefs>;
  const say = (r.say && typeof r.say === "object" ? r.say : {}) as Partial<CalloutParts>;
  const bool = (v: unknown, d: boolean) => typeof v === "boolean" ? v : d;
  return {
    freq: CALLOUT_FREQS.includes(r.freq as CalloutFreq) ? r.freq as CalloutFreq : DEFAULT_AUDIO.freq,
    band: typeof r.band === "number" && r.band >= BAND_MIN && r.band <= BAND_MAX ? r.band : DEFAULT_AUDIO.band,
    hrWarn: HR_WARNS.includes(r.hrWarn as HrWarn) ? r.hrWarn as HrWarn : DEFAULT_AUDIO.hrWarn,
    say: {
      pace: bool(say.pace, DEFAULT_AUDIO.say.pace), hr: bool(say.hr, DEFAULT_AUDIO.say.hr),
      dist: bool(say.dist, DEFAULT_AUDIO.say.dist), left: bool(say.left, DEFAULT_AUDIO.say.left),
    },
    freeOn: bool(r.freeOn, DEFAULT_AUDIO.freeOn),
  };
}

export type CalloutClock = { lastAtSec: number; lastKm: number };

/**
 * Is a status callout due? Time-based callouts run on MOVING time (a pause
 * doesn't count) and wait out the first stretch of a step; per-km ones fire
 * on each whole kilometre crossed.
 */
export function calloutDue(
  freq: CalloutFreq,
  now: { movingSec: number; km: number; stepElapsedSec: number },
  clock: CalloutClock,
): boolean {
  if (freq === "km") return Math.floor(now.km) > clock.lastKm;
  return now.movingSec - clock.lastAtSec >= freq && now.stepElapsedSec >= CALLOUT_MIN_INTO_STEP_SEC;
}

/** HR warning due: over the work step's zone top by the margin, not more often than HR_WARN_EVERY_SEC. */
export function hrWarnDue(
  step: WorkoutStep, warn: HrWarn, bpm: number | null | undefined,
  movingSec: number, lastWarnSec: number,
): boolean {
  if (warn === "off" || movingSec - lastWarnSec < HR_WARN_EVERY_SEC) return false;
  return hrOver(step, bpm, warn);
}

export type CalloutContent = {
  km: number | null;
  verdict: PaceVerdict | null;
  pace: number | null;
  target: number | null;
  hr: number | null;
  left: { m?: number; sec?: number } | null;
};

/** What the sentence says, given the runner's choices; the caller words it. */
export function calloutContent(
  say: CalloutParts, step: WorkoutStep,
  now: { km: number; curPace: number; hr: number | null; left: { m?: number; sec?: number } },
  perKm: boolean,
): CalloutContent {
  const hasPace = now.curPace > 0;
  const hasLeft = now.left.m != null || now.left.sec != null;
  return {
    km: say.dist || perKm ? now.km : null,
    verdict: say.pace ? paceVerdict(step, now.curPace) : null,
    pace: say.pace && hasPace ? now.curPace : null,
    target: step.pace ?? null,
    hr: say.hr && now.hr != null ? now.hr : null,
    left: say.left && hasLeft ? now.left : null,
  };
}
