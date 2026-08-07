// GPX / TCX activity-file parsing for the file import provider.
//
// Small and dependency-free like csv.ts: DOMParser (browser + jsdom) over the
// two well-known schemas. GPX: <trkpt lat lon><ele/><time/> plus the Garmin
// TrackPointExtension heart rate (any-namespace <hr>). TCX: <Trackpoint> with
// <Time>, <Position>, <AltitudeMeters>, <HeartRateBpm><Value>. One file = one
// activity; distance/elevation are derived from the trace with the same geo
// math as live GPS runs, so an imported map and its stats agree.
import { ymd } from "./format";
import { distanceKm, elevGainM, type TrackPointOrGap } from "./geo";
import { hrSummary } from "./hr";
import { normalizeHrSamples } from "../imports/series";
import type { ImportedRun } from "../imports/types";

export const MAX_GPX_BYTES = 20 * 1024 * 1024; // 20 MB — GPX is verbose

type ParseOk = { run: ImportedRun; error?: undefined };
type ParseErr = { run?: undefined; error: string };
export type ActivityParseResult = ParseOk | ParseErr;

const num = (v: string | null | undefined) => {
  if (v == null || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

const text = (el: Element, tag: string) => {
  const c = el.getElementsByTagName(tag)[0];
  return c?.textContent ?? null;
};

// First descendant whose local name matches, ignoring namespace prefixes —
// Garmin writes <ns3:hr>, other tools <gpxtpx:hr> or plain <hr>.
function localText(el: Element, local: string): string | null {
  for (const d of Array.from(el.getElementsByTagName("*"))) {
    if (d.localName === local || d.nodeName.toLowerCase().endsWith(":" + local)) return d.textContent;
  }
  return null;
}

function parseXml(input: string): Document | null {
  try {
    const doc = new DOMParser().parseFromString(input, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) return null;
    return doc;
  } catch { return null; }
}

const ymdLocal = (ms: number) => ymd(new Date(ms));

// GPS-less fallback (indoor/treadmill exports): the file's own time range and
// declared distance, used when there are no positioned trackpoints to derive
// them from. TCX carries per-point <Time> and cumulative <DistanceMeters> even
// without <Position>.
type NoGpsFallback = { startMs: number; endMs: number; km: number };

// Reduce collected trackpoints + HR samples to an ImportedRun (with the trace
// attached as transient `points` for the caller to saveRoute). A file without
// GPS positions still imports via `fallback` — it just has no route/map.
// Exported so other activity-file parsers (fit.ts) share the one derivation, so
// a FIT map and its stats agree with a GPX one point-for-point.
export function activityToRun(
  points: TrackPointOrGap[],
  hr: { bpm: number; t: number }[],
  label: string,
  fallback?: NoGpsFallback | null,
): ActivityParseResult {
  const times = points.filter((p): p is TrackPointOrGap & readonly number[] => !!p && p[2] != null).map(p => p![2] as number);
  const gps = times.length > 0;
  if (!gps && !fallback) return { error: "No usable trackpoints found in that file." };
  const startMs = gps ? times[0] : fallback!.startMs;
  const endMs = gps ? times[times.length - 1] : fallback!.endMs;
  // With GPS, derive distance from the trace (same geo math as live runs, so an
  // imported map and its stats agree); otherwise trust the file's distance.
  const km = gps ? Math.round(distanceKm(points) * 100) / 100 : Math.round(fallback!.km * 100) / 100;
  if (km < 0.05) return { error: "That file has no distance — check it's a recorded activity." };
  const s = hrSummary(hr);
  const run: ImportedRun = {
    date: ymdLocal(startMs),
    type: "EASY",
    km,
    durationSec: Math.max(1, Math.round((endMs - startMs) / 1000)),
    hr: s.hrAvg,
    hrMax: s.hrMax,
    effort: 5,
    notes: label,
    source: "file",
    startedAt: new Date(startMs).toISOString(),
  };
  if (gps) {
    run.points = points;
    const elevation = elevGainM(points);
    if (elevation > 0) run.elevation = Math.round(elevation);
  }
  // Keep the raw HR stream (not just the avg/max aggregates) so an imported file
  // — like a live BLE run or a HealthKit import — powers RunDetailModal's HR
  // chart and time-in-zone card. persistImportedRoute folds it into the
  // stats.hrSamples sidecar (with GPS → routeId, HR-only → hrRouteId). Run it
  // through the shared normalizer (round bpm, drop zero/NaN) so every import
  // source lands the same sanitized shape in the sidecar.
  const cleanHr = normalizeHrSamples(hr);
  if (cleanHr.length) run.hrSamples = cleanHr;
  return { run };
}

function parseGpx(doc: Document): ActivityParseResult {
  const pts: TrackPointOrGap[] = [];
  const hr: { bpm: number; t: number }[] = [];
  for (const el of Array.from(doc.getElementsByTagName("trkpt"))) {
    const lat = num(el.getAttribute("lat"));
    const lng = num(el.getAttribute("lon"));
    const t = Date.parse(text(el, "time") || "");
    if (lat == null || lng == null || !Number.isFinite(t)) continue;
    const alt = num(text(el, "ele"));
    pts.push([lat, lng, t, alt]);
    const bpm = num(localText(el, "hr"));
    if (bpm) hr.push({ bpm, t });
  }
  return activityToRun(pts, hr, "GPX import");
}

function parseTcx(doc: Document): ActivityParseResult {
  const pts: TrackPointOrGap[] = [];
  const hr: { bpm: number; t: number }[] = [];
  const times: number[] = [];
  let lastDistM = 0;
  for (const el of Array.from(doc.getElementsByTagName("Trackpoint"))) {
    const t = Date.parse(text(el, "Time") || "");
    if (!Number.isFinite(t)) continue;
    times.push(t);
    // Cumulative distance — present even on indoor/treadmill sessions with no GPS.
    const dM = num(text(el, "DistanceMeters"));
    if (dM != null && dM > lastDistM) lastDistM = dM;
    const pos = el.getElementsByTagName("Position")[0];
    const lat = pos ? num(text(pos, "LatitudeDegrees")) : null;
    const lng = pos ? num(text(pos, "LongitudeDegrees")) : null;
    if (lat != null && lng != null) pts.push([lat, lng, t, num(text(el, "AltitudeMeters"))]);
    const bpmEl = el.getElementsByTagName("HeartRateBpm")[0];
    const bpm = bpmEl ? num(text(bpmEl, "Value")) : null;
    if (bpm) hr.push({ bpm, t });
  }
  const fallback = times.length >= 2 && lastDistM > 0
    ? { startMs: times[0], endMs: times[times.length - 1], km: lastDistM / 1000 }
    : null;
  return activityToRun(pts, hr, "TCX import", fallback);
}

// Parse a single GPX or TCX activity export. Returns { run } (with transient
// route `points`) or { error } — never throws.
export function parseActivityFile(input: string, kind: "gpx" | "tcx"): ActivityParseResult {
  const trimmed = (input || "").trim();
  if (!trimmed) return { error: "Empty file." };
  const doc = parseXml(trimmed);
  if (!doc) return { error: "Couldn't read that file — it doesn't look like valid " + kind.toUpperCase() + "." };
  return kind === "gpx" ? parseGpx(doc) : parseTcx(doc);
}
