// Heart-rate zone definitions and bpm calculations, shared by the HR Zones
// settings screen and the per-session targets on the plan.
import type { RunType, SettingsState } from "../types";

export const HR_ZONES = [
  {n:1,name:"Recovery",     lo:0.50,hi:0.60,clr:"#60a5fa",type:"Aerobic",   desc:"Very easy — active recovery, warm-up/cool-down"},
  {n:2,name:"Aerobic Base", lo:0.60,hi:0.70,clr:"#34d399",type:"Aerobic",   desc:"Easy runs, fat burning, building endurance base"},
  {n:3,name:"Aerobic Tempo",lo:0.70,hi:0.80,clr:"#facc15",type:"Aerobic",   desc:"Moderate effort — marathon and long-run pace"},
  {n:4,name:"Threshold",    lo:0.80,hi:0.90,clr:"#fb923c",type:"Anaerobic", desc:"Comfortably hard — lactate threshold, tempo runs"},
  {n:5,name:"VO2 Max",      lo:0.90,hi:1.00,clr:"#f87171",type:"Anaerobic", desc:"Maximum effort — short intervals, race pace"},
];

// Each session type maps onto one (or a span of) HR_ZONES — the bpm range shown
// is derived from those zones' percentages via hrZoneBpm.
export const SESSION_ZONES = {
  EASY:      {zones:[2],   label:"Z2 · Aerobic Base",        clr:"#34d399"},
  LONG:      {zones:[2],   label:"Z2 · Aerobic Base",        clr:"#34d399"},
  TEMPO:     {zones:[3,4], label:"Z3-4 · Lactate Threshold", clr:"#fb923c"},
  INTERVALS: {zones:[4,5], label:"Z4-5 · Max effort (reps)", clr:"#f87171"},
  RACE:      {zones:[3,4], label:"Z3-4 · Race effort",       clr:"#fb923c"},
  WALK:      {zones:[1],   label:"Z1 · Recovery",            clr:"#60a5fa"},
  // Cross-training (indoor bike/elliptical, docs/indoor-sessions.md). Same
  // aerobic-base target as an easy run — stated explicitly rather than left to
  // sessionHR's EASY fallback, since base building is the point of these.
  OTHER:     {zones:[2],   label:"Z2 · Aerobic Base",        clr:"#34d399"},
};
type SessionZoneType = keyof typeof SESSION_ZONES;
type HrSample = { bpm: number; t: number };

// Tanaka max-HR estimate (208 − 0.7 × age) — the one fallback used whenever
// the user hasn't entered a measured max HR.
export const tanakaMaxHR = (age: number) => Math.round(208 - 0.7 * age);

// Age at `today` from a plain birth year (e.g. 1985). Null when absent or when
// the derived age is implausible (outside 10..90, mirroring the input bounds).
// `today` is injectable for deterministic tests.
export function deriveAge(birthYear: number | null | undefined, today: Date = new Date()): number | null {
  if (!birthYear) return null;
  const age = today.getFullYear() - birthYear;
  return age >= 10 && age <= 90 ? age : null;
}

// Runner age from settings: birthYear wins; the legacy static `age` field
// (written by older app versions and pre-birthYear blobs) is the fallback.
// Null = unknown.
export function runnerAge(s: Partial<Pick<SettingsState, "birthYear" | "age">>, today?: Date): number | null {
  const fromYear = deriveAge(s.birthYear, today);
  if (fromYear != null) return fromYear;
  const legacy = Number(s.age) || 0;
  return legacy >= 10 && legacy <= 90 ? legacy : null;
}

// Effective max HR for zone math: explicit maxHR → Tanaka from runnerAge → 0.
export function effectiveMaxHR(s: Partial<Pick<SettingsState, "maxHR" | "birthYear" | "age">>, today?: Date): number {
  if (s.maxHR) return s.maxHR;
  const age = runnerAge(s, today);
  return age != null ? tanakaMaxHR(age) : 0;
}

// Compute the bpm range for a zone using the Karvonen (heart-rate reserve)
// method — it accounts for resting HR, so it's more accurate than plain % of
// MaxHR.
export function hrZoneBpm(loPct: number, hiPct: number, maxHR: number, restHR: number) {
  if (!maxHR) return null;
  const hrr = maxHR - restHR;
  if (hrr <= 0) return null;
  return {lo: Math.round(hrr * loPct + restHR), hi: Math.round(hrr * hiPct + restHR)};
}

// Classify an average HR into its zone number (1..5) for the given profile,
// or null if it can't be computed. Last zone is open-ended at the top.
export function runZoneIndex(hr: number | null | undefined, maxHR: number, restHR: number) {
  if (!hr || !maxHR) return null;
  const idx = HR_ZONES.findIndex((z, i) => {
    const r = hrZoneBpm(z.lo, z.hi, maxHR, restHR);
    if (!r) return false;
    return i === HR_ZONES.length - 1 ? hr >= r.lo : hr >= r.lo && hr < r.hi;
  });
  return idx >= 0 ? idx + 1 : null;
}

// Parse a Bluetooth Heart Rate Measurement characteristic value (GATT 0x2A37),
// as delivered by Web Bluetooth and the @capacitor-community/bluetooth-le
// notification callback (both hand us a DataView). Returns { bpm, rr } where rr
// is R-R intervals in milliseconds (empty array if none present), or null when
// the value is unusable. Pure + unit-tested — no SDK/React imports.
//
// Layout: byte 0 is flags; bit 0 picks the HR value format (0 = uint8,
// 1 = uint16), bit 3 flags an optional energy-expended uint16, bit 4 flags
// trailing R-R intervals (uint16, units of 1/1024 s).
export function parseHrMeasurement(view: DataView | null | undefined) {
  if (!view || typeof view.getUint8 !== "function" || view.byteLength < 2) return null;
  const flags = view.getUint8(0);
  let i = 1;
  let bpm;
  if (flags & 0x01) {
    if (i + 2 > view.byteLength) return null;
    bpm = view.getUint16(i, true); i += 2; // uint16, little-endian
  }
  else { bpm = view.getUint8(i); i += 1; }
  if (!bpm) return null; // 0 bpm = no skin contact / invalid reading
  if (flags & 0x08) i += 2; // skip energy expended
  const rr: number[] = [];
  if (flags & 0x10) {
    for (; i + 2 <= view.byteLength; i += 2) {
      rr.push(Math.round(view.getUint16(i, true) * 1000 / 1024)); // 1/1024 s → ms
    }
  }
  return { bpm, rr };
}

// Reduce a stream of { bpm, t } samples to the summary a run stores: latest
// (live display), rounded average, and peak. Empty stream → all null.
export function hrSummary(samples?: HrSample[] | null) {
  if (!samples || !samples.length) return { hr: null, hrAvg: null, hrMax: null };
  let sum = 0, max = 0;
  for (const s of samples) { sum += s.bpm; if (s.bpm > max) max = s.bpm; }
  return { hr: samples[samples.length - 1].bpm, hrAvg: Math.round(sum / samples.length), hrMax: max };
}

// Seconds of a run a { bpm, t } stream actually measured. Each sample covers the
// gap to the next one, capped so a dropped link never counts as measured time.
// A single sample measures nothing.
//
// The cap ADAPTS to the stream's own cadence (median gap × 3, floored at 10s)
// unless one is passed explicitly. A BLE strap notifies at ~1-2Hz and lands on
// the 10s floor, but `stats.hrSamples` is also written by the watch / HealthKit /
// GPX importers, whose series can legitimately be one sample a minute — a fixed
// cap would score a perfectly continuous import at 17% and call it a dropout.
// Three times the stream's own spacing is still sampling; beyond that is a hole.
export function hrMeasuredSec(samples?: HrSample[] | null, capSec?: number): number {
  if (!samples || samples.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < samples.length; i++) gaps.push(Math.max(0, samples[i].t - samples[i - 1].t));
  let capMs: number;
  if (capSec != null) capMs = capSec * 1000;
  else {
    const sorted = gaps.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    capMs = Math.max(10000, median * 3);
  }
  let ms = 0;
  for (const g of gaps) ms += Math.min(g, capMs);
  return ms / 1000;
}

// Fraction (0..1) of a run's duration the HR stream covers. This is the guard on
// every run-level HR claim: a Bluetooth link that drops mid-run leaves a stream
// whose mean is the mean of whatever fragment survived, not the run's heart rate
// — and that number feeds the coach, HR zones and race predictions.
export function hrCoverage(samples: HrSample[] | null | undefined, durationSec: number): number {
  if (!durationSec || durationSec <= 0) return 0;
  return Math.min(1, hrMeasuredSec(samples) / durationSec);
}

// Below this, a run keeps its raw samples (the detail chart still draws them)
// but claims no hr/hrMax of its own — see LiveRunTracker.handleSave.
export const HR_MIN_COVERAGE = 0.5;

// Union of two { bpm, t } streams, sorted ascending, dropping entries from `b`
// that duplicate one already in `a`. Used to fold the native HR journal into
// what JS saw live: the two record the same notification a few ms apart, so the
// match is a tolerance, not an equality. Sensors notify at ~1-2Hz, well outside
// the default window.
export function mergeHrSamples(
  a?: HrSample[] | null,
  b?: HrSample[] | null,
  toleranceMs = 250,
): HrSample[] {
  const base = (a || []).slice().sort((x, y) => x.t - y.t);
  const extra = (b || []).filter(s => s && Number.isFinite(s.t) && s.bpm > 0);
  if (!extra.length) return base;
  if (!base.length) return extra.slice().sort((x, y) => x.t - y.t);
  const out = base.slice();
  for (const s of extra) {
    // base is sorted, so binary-search the insertion point and check neighbours.
    let lo = 0, hi = base.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (base[mid].t < s.t) lo = mid + 1; else hi = mid - 1;
    }
    const near = [lo - 1, lo].some(i =>
      i >= 0 && i < base.length && Math.abs(base[i].t - s.t) <= toleranceMs);
    if (!near) out.push(s);
  }
  return out.sort((x, y) => x.t - y.t);
}

// Time spent in each HR zone (seconds), from a raw { bpm, t } stream — the
// time-in-zone card in RunDetailModal (BLE runs only). Accumulates the gap
// between consecutive samples into the earlier sample's zone; each gap is CAPPED
// (default 10s) so a paused stretch or a dropped connection can't inflate a zone.
// Returns one entry per zone 1..5, or [] when the profile can't classify (no
// maxHR / unusable reserve) or there's nothing to measure — so the card hides.
export function timeInZones(
  samples: HrSample[] | null | undefined,
  maxHR: number,
  restHR: number,
  opts?: { capSec?: number },
): { zone: number; sec: number }[] {
  if (!maxHR || !samples || samples.length < 2) return [];
  const capMs = (opts?.capSec ?? 10) * 1000;
  const sec = [0, 0, 0, 0, 0]; // zones 1..5
  // Boundaries once, not per sample — a 2h 1Hz strap is ~7200 samples.
  const bands = HR_ZONES.map(z => hrZoneBpm(z.lo, z.hi, maxHR, restHR));
  const zoneOf = (hr: number) => {
    if (!hr) return null;
    const i = bands.findIndex((r, n) =>
      r && (n === bands.length - 1 ? hr >= r.lo : hr >= r.lo && hr < r.hi));
    return i >= 0 ? i + 1 : null;
  };
  let any = false;
  for (let i = 1; i < samples.length; i++) {
    const dt = Math.min(Math.max(0, samples[i].t - samples[i - 1].t), capMs);
    const z = zoneOf(samples[i - 1].bpm);
    if (z) { sec[z - 1] += dt / 1000; any = true; }
  }
  return any ? sec.map((s, i) => ({ zone: i + 1, sec: s })) : [];
}

export function sessionHR(type: RunType | string, settings: Partial<Pick<SettingsState, "maxHR" | "restHR">>) {
  const key = type in SESSION_ZONES ? type as SessionZoneType : "EASY";
  const cfg = SESSION_ZONES[key];
  const loZone = HR_ZONES[cfg.zones[0] - 1];
  const hiZone = HR_ZONES[cfg.zones[cfg.zones.length - 1] - 1];
  const r = hrZoneBpm(loZone.lo, hiZone.hi, settings.maxHR || 0, settings.restHR || 60);
  if (!r) return null;
  return {lo:r.lo, hi:r.hi, label:cfg.label, clr:cfg.clr};
}
