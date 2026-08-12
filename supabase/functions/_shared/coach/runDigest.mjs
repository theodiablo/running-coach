// Server-side run-detail digest for the coach agent's get_run_detail tool:
// collapses a run_routes row into a ~1-2KB coordinate-free summary (splits, HR
// zones, downsampled series). Ports src/utils/{geo,runSeries,runSplits,hr}.ts —
// keep in sync (parity-tested by runDigest.test.ts). flattenTrack structurally
// never emits lat/lng, so a digest cannot leak location. Plain ESM, no imports.

const R = 6371000; // Earth's mean radius, metres
const rad = (d) => (d * Math.PI) / 180;

// Great-circle (haversine) distance between two stored points, in metres.
// Port of geo.ts haversineM, array-tuple form only.
export function haversineM(a, b) {
  const dLat = rad(Number(b[0]) - Number(a[0])), dLng = rad(Number(b[1]) - Number(a[1]));
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(Number(a[0]))) * Math.cos(rad(Number(b[0]))) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Port of geo.ts flattenTrack — the ONE jitter-gated, gap-aware cumulative
// distance walk — minus the coordinates: output rows are { t, alt, cumKm,
// segStart } only.
export function flattenTrack(points, jitterM = 3) {
  const out = [];
  let cumM = 0, prev = null, newSeg = true;
  for (const p of points) {
    if (!p) { prev = null; newSeg = true; continue; } // gap: break segment, no distance
    if (prev) { const d = haversineM(prev, p); if (d >= jitterM) cumM += d; }
    out.push({ t: Number(p[2]), alt: p[3] == null ? null : Number(p[3]), cumKm: cumM / 1000, segStart: newSeg });
    prev = p; newSeg = false;
  }
  return out;
}

// Port of geo.ts elevGainM over already-flattened rows (alt-only, ±minM
// hysteresis band; null altitudes skipped). geo.ts resets the band at `null`
// gap markers; flattenTrack drops those, so here a row with segStart (the
// first fix after a gap) resets instead — same semantics. Rows without a
// segStart field (per-split slices) never reset, matching buildSplits' use of
// gap-free coordinate objects.
export function elevGainM(rows, minM = 5) {
  let gain = 0, prev = null;
  for (const r of rows) {
    if (!r || r.segStart) prev = null;
    if (!r) continue;
    const alt = r.alt;
    if (alt == null) continue;
    if (prev != null) {
      const diff = alt - prev;
      if (diff >= minM) { gain += diff; prev = alt; }
      else if (diff <= -minM) { prev = alt; }
      // within the noise band: keep prev (hysteresis)
    } else {
      prev = alt;
    }
  }
  return gain;
}

// Nearest sample bpm to time `t` within ±windowMs (samples time-sorted).
// Port of runSeries.ts avgBpmIn.
function avgBpmIn(samples, from, to) {
  let lo = 0, hi = samples.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < from) lo = mid + 1;
    else hi = mid - 1;
  }
  let sum = 0, n = 0;
  for (let i = lo; i < samples.length && samples[i].t <= to; i++) { sum += samples[i].bpm; n++; }
  return n ? Math.round(sum / n) : null;
}

// Port of runSeries.ts buildRunSeries: one row per real point with cumulative
// distance, rolling ~200m distance-window pace, altitude, and HR averaged over
// the point's own time slice. Rows are { distKm, tSec, elevM, paceSecPerKm, hr }.
export function buildSeriesRows(points, hrSamples, opts) {
  const paceWindowM = opts?.paceWindowM ?? 200;
  const jitterM = opts?.jitterM ?? 3;
  const hrWindowMs = opts?.hrWindowMs ?? 4000;
  const hrSliceMaxMs = opts?.hrSliceMaxMs ?? 30000;
  const hr = hrSamples && hrSamples.length ? hrSamples : null;

  const flat = flattenTrack(points, jitterM);
  if (!flat.length) return [];
  const t0 = flat[0].t;

  const rows = [];
  let segStartIdx = 0;
  for (let i = 0; i < flat.length; i++) {
    const f = flat[i];
    if (f.segStart) segStartIdx = i;
    // Rolling DISTANCE window (not time) — stored points are Douglas-Peucker
    // thinned, so a time window leaves pace null on straight sparse stretches.
    let pace = null;
    if (i > segStartIdx) {
      let w = i - 1;
      while (w > segStartIdx && (f.cumKm - flat[w - 1].cumKm) * 1000 <= paceWindowM) w--;
      const dt = (f.t - flat[w].t) / 1000;
      const dkm = f.cumKm - flat[w].cumKm;
      if (dt > 0 && dkm > 0) pace = dt / dkm;
    }
    // The point's own slice: halfway to each neighbour, never across a gap,
    // floored so dense points still catch a sample and capped so a sparse
    // stretch stays local.
    let hrBpm = null;
    if (hr) {
      const prev = i > segStartIdx ? flat[i - 1] : null;
      const next = i + 1 < flat.length && !flat[i + 1].segStart ? flat[i + 1] : null;
      const back = Math.max(hrWindowMs, Math.min(prev ? (f.t - prev.t) / 2 : 0, hrSliceMaxMs));
      const fwd = Math.max(hrWindowMs, Math.min(next ? (next.t - f.t) / 2 : 0, hrSliceMaxMs));
      hrBpm = avgBpmIn(hr, f.t - back, f.t + fwd);
    }

    rows.push({
      distKm: f.cumKm,
      tSec: (f.t - t0) / 1000,
      elevM: f.alt,
      paceSecPerKm: pace,
      hr: hrBpm,
    });
  }
  return rows;
}

// Linear-interpolated time (epoch ms) at a cumulative-km mark. Port of
// runSplits.ts timeAtKm.
function timeAtKm(pts, km) {
  if (!pts.length) return 0;
  if (km <= pts[0].cumKm) return pts[0].t;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].cumKm >= km) {
      const a = pts[i - 1], b = pts[i];
      const span = b.cumKm - a.cumKm;
      if (span <= 0) return b.t;
      return a.t + ((km - a.cumKm) / span) * (b.t - a.t);
    }
  }
  return pts[pts.length - 1].t;
}

// Port of runSplits.ts buildSplits, minus the fastest/slowest flags (the model
// can read them off the numbers). Rows are { km, distKm, durationSec,
// paceSecPerKm, elevGainM, avgHr }.
export function buildSplitRows(points, hrSamples, opts) {
  const hr = hrSamples && hrSamples.length ? hrSamples : null;
  const pts = flattenTrack(points, opts?.jitterM ?? 3);
  const totalKm = pts.length ? pts[pts.length - 1].cumKm : 0;
  if (pts.length < 2 || totalKm <= 0) return [];

  const avgHrBetween = (t0, t1) => {
    if (!hr) return null;
    let lo = 0, hi = hr.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (hr[m].t < t0) lo = m + 1; else hi = m - 1; }
    let sum = 0, n = 0;
    for (let i = lo; i < hr.length && hr[i].t <= t1; i++) { sum += hr[i].bpm; n++; }
    return n ? Math.round(sum / n) : null;
  };

  const splits = [];
  const nFull = Math.floor(totalKm);
  for (let k = 0; k < nFull || (k === nFull && totalKm - nFull > 0.001); k++) {
    const startKm = k;
    const endKm = Math.min(k + 1, totalKm);
    const tStart = timeAtKm(pts, startKm);
    const tEnd = timeAtKm(pts, endKm);
    const durationSec = (tEnd - tStart) / 1000;
    const distKm = endKm - startKm;
    // Strip segStart so a mid-split gap doesn't reset the band — buildSplits
    // passes gap-free coordinate objects here, with no resets.
    const alts = pts.filter((pt) => pt.cumKm >= startKm && pt.cumKm <= endKm).map((pt) => ({ alt: pt.alt }));
    splits.push({
      km: k + 1,
      distKm,
      durationSec,
      paceSecPerKm: distKm > 0 ? durationSec / distKm : 0,
      elevGainM: Math.round(elevGainM(alts)),
      avgHr: avgHrBetween(tStart, tEnd),
    });
  }
  return splits;
}

// HR zone fractions of heart-rate reserve (Karvonen) — ports of hr.ts HR_ZONES
// (name/lo/hi only) and the zone math below it.
export const HR_ZONES = [
  { n: 1, name: "Recovery", lo: 0.50, hi: 0.60 },
  { n: 2, name: "Aerobic Base", lo: 0.60, hi: 0.70 },
  { n: 3, name: "Aerobic Tempo", lo: 0.70, hi: 0.80 },
  { n: 4, name: "Threshold", lo: 0.80, hi: 0.90 },
  { n: 5, name: "VO2 Max", lo: 0.90, hi: 1.00 },
];

export const tanakaMaxHR = (age) => Math.round(208 - 0.7 * age);

// Ports of hr.ts deriveAge / runnerAge / effectiveMaxHR (`today` injectable for
// deterministic tests).
export function runnerAge(s, today = new Date()) {
  if (s.birthYear) {
    const age = today.getFullYear() - s.birthYear;
    if (age >= 10 && age <= 90) return age;
  }
  const legacy = Number(s.age) || 0;
  return legacy >= 10 && legacy <= 90 ? legacy : null;
}

export function effectiveMaxHR(s, today) {
  if (s.maxHR) return s.maxHR;
  const age = runnerAge(s, today);
  return age != null ? tanakaMaxHR(age) : 0;
}

function hrZoneBpm(loPct, hiPct, maxHR, restHR) {
  if (!maxHR) return null;
  const hrr = maxHR - restHR;
  if (hrr <= 0) return null;
  return { lo: Math.round(hrr * loPct + restHR), hi: Math.round(hrr * hiPct + restHR) };
}

export function runZoneIndex(hr, maxHR, restHR) {
  if (!hr || !maxHR) return null;
  const idx = HR_ZONES.findIndex((z, i) => {
    const r = hrZoneBpm(z.lo, z.hi, maxHR, restHR);
    if (!r) return false;
    return i === HR_ZONES.length - 1 ? hr >= r.lo : hr >= r.lo && hr < r.hi;
  });
  return idx >= 0 ? idx + 1 : null;
}

// Port of hr.ts timeInZones — per-zone seconds from a raw { bpm, t } stream,
// inter-sample gaps capped (default 10s) so pauses can't inflate a zone.
export function timeInZones(samples, maxHR, restHR, opts) {
  if (!maxHR || !samples || samples.length < 2) return [];
  const capMs = (opts?.capSec ?? 10) * 1000;
  const sec = [0, 0, 0, 0, 0];
  let any = false;
  for (let i = 1; i < samples.length; i++) {
    const dt = Math.min(Math.max(0, samples[i].t - samples[i - 1].t), capMs);
    const z = runZoneIndex(samples[i - 1].bpm, maxHR, restHR);
    if (z) { sec[z - 1] += dt / 1000; any = true; }
  }
  return any ? sec.map((s, i) => ({ zone: i + 1, sec: s })) : [];
}

// Downsample series rows into ~n even buckets along `key` ("distKm" or "tSec"):
// median pace, mean HR, and last elevation per bucket — enough shape for the
// model to spot fades/spikes without hundreds of rows.
export function downsampleSeries(rows, n = 60, key = "distKm") {
  if (!rows.length) return [];
  const span = rows[rows.length - 1][key] - rows[0][key];
  if (span <= 0) return [rows[rows.length - 1]];
  const start = rows[0][key];
  const buckets = Array.from({ length: n }, () => []);
  for (const r of rows) {
    const i = Math.min(n - 1, Math.floor(((r[key] - start) / span) * n));
    buckets[i].push(r);
  }
  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[s.length >> 1];
  };
  const out = [];
  for (const b of buckets) {
    if (!b.length) continue;
    const last = b[b.length - 1];
    const paces = b.map((r) => r.paceSecPerKm).filter((p) => p != null);
    const hrs = b.map((r) => r.hr).filter((h) => h != null);
    out.push({
      [key]: last[key],
      paceSecPerKm: median(paces),
      elevM: last.elevM,
      hr: hrs.length ? hrs.reduce((a, h) => a + h, 0) / hrs.length : null,
    });
  }
  return out;
}

const round2 = (x) => Math.round(x * 100) / 100;

// Compose the digest the model sees. `run` is the rc_runs entry, `points` /
// `stats` the run_routes row, `settings` the rc_settings blob (for HR zones).
// Degenerate inputs produce a header + explanatory `notes`, never a throw.
// `today` is optional (tests inject it for deterministic Tanaka age fallback).
export function buildRunDigest({ run, points, stats, settings, today = undefined }) {
  const pts = Array.isArray(points) ? points : [];
  const hrSamples = Array.isArray(stats?.hrSamples) ? stats.hrSamples : [];
  const maxHR = effectiveMaxHR(settings ?? {}, today);
  const restHR = (settings?.restHR) || 60; // match every other zone call site's fallback

  const notes = [];
  const digest = {
    runId: run.id,
    date: run.date,
    type: run.type,
    distKm: run.km ?? null,
    durationSec: run.durationSec ?? null,
    avgHr: run.hr ?? null,
    maxHr: run.hrMax ?? null,
    effort: run.effort ?? null,
    notes,
  };

  if (!pts.length && !hrSamples.length) {
    notes.push("no detailed data recorded for this run — advise from the summary fields above");
    return digest;
  }

  if (pts.length) {
    const flat = flattenTrack(pts);
    const hasAlt = flat.some((f) => f.alt != null);
    if (hasAlt) digest.elevGainM = Math.round(elevGainM(flat));
    // Compact keys keep a marathon-scale digest well under the size budget:
    // splits {k: split #, d: partial-km length (full kms omit it), p: pace
    // sec/km, e: elev gain m, h: avg hr}; series {d: cum km, p, e, h}. The
    // engine's tool_result framing line explains them to the model.
    const seriesRows = buildSeriesRows(pts, hrSamples);
    const allSplits = buildSplitRows(pts, hrSamples);
    digest.splits = allSplits.slice(0, 45).map((s) => {
      const row = { k: s.km, p: Math.round(s.paceSecPerKm), e: s.elevGainM, h: s.avgHr };
      if (s.distKm < 0.995) row.d = round2(s.distKm);
      return row;
    });
    if (allSplits.length > 45) {
      notes.push(`splits truncated to the first 45 of ${allSplits.length} km — the downsampled series still covers the whole run`);
    }
    digest.series = downsampleSeries(seriesRows, 50, "distKm").map((r) => ({
      d: round2(r.distKm),
      p: r.paceSecPerKm == null ? null : Math.round(r.paceSecPerKm),
      e: r.elevM == null ? null : Math.round(r.elevM),
      h: r.hr == null ? null : Math.round(r.hr),
    }));
    if (!hasAlt) notes.push("no altitude data recorded (elevation unavailable)");
  } else {
    // HR-only route (e.g. a watch import without GPS): time-indexed HR series.
    notes.push("GPS was not recorded for this run — heart-rate detail only");
    const rows = hrSamples.map((s) => ({ tSec: (s.t - hrSamples[0].t) / 1000, hr: s.bpm, paceSecPerKm: null, elevM: null }));
    digest.series = downsampleSeries(rows, 50, "tSec").map((r) => ({
      t: Math.round(r.tSec),
      h: r.hr == null ? null : Math.round(r.hr),
    }));
  }

  if (hrSamples.length) {
    const zones = timeInZones(hrSamples, maxHR, restHR);
    if (zones.length) {
      const total = zones.reduce((a, z) => a + z.sec, 0) || 1;
      digest.hrZones = zones.map((z) => ({
        zone: `Z${z.zone}`,
        label: HR_ZONES[z.zone - 1].name,
        sec: Math.round(z.sec),
        pctTime: Math.round((z.sec / total) * 100),
      }));
    } else if (!maxHR) {
      notes.push("HR zones unavailable: the runner has not set a max heart rate");
    } else {
      // maxHR is set but zones still failed: an unusable reserve (restHR >=
      // maxHR) or too few samples — do NOT tell the model max HR is missing.
      notes.push("HR zones unavailable (too few samples or an unusable HR profile)");
    }
  } else {
    notes.push("no heart-rate data recorded for this run");
  }

  return digest;
}
