import { parseActivityFile } from "../../utils/gpx";
import { makeCloudOauth } from "../cloudOauth";
import type { ImportProvider, ImportedRun } from "../types";

// Polar (AccessLink) cloud import. Secret half (OAuth exchange + exercise pull)
// lives in the `polar-import` edge function; this client starts the OAuth
// redirect (via the shared makeCloudOauth machinery) and maps the returned
// exercises. Dormant until VITE_POLAR_CLIENT_ID is set. Architecture, OAuth
// return paths (web vs native): docs/integrations-polar.md.

const POLAR_CLIENT_ID = import.meta.env?.VITE_POLAR_CLIENT_ID as string | undefined;

const oauth = makeCloudOauth({
  provider: "polar",
  authUrl: "https://flow.polar.com/oauth2/authorization",
  clientId: POLAR_CLIENT_ID,
  scope: "accesslink.read_all",
  functionName: "polar-import",
});

export const polarEnabled = oauth.enabled;
export const expectedPolarStates = oauth.expectedStates;
export const completePolarAuth = oauth.completeAuth;

// Sports we import as runs (Polar `detailed-sport-info` / `sport`). Anything else
// (cycling, swimming…) is skipped. Walking/hiking → WALK, the rest → EASY.
const WALK_SPORTS = new Set(["WALKING", "HIKING", "NORDIC_WALKING"]);
const RUN_SPORTS = new Set(["RUNNING", "JOGGING", "TRAIL_RUNNING", "ROAD_RUNNING", "TREADMILL_RUNNING", "TRACK_AND_FIELD_RUNNING"]);

// ISO-8601 duration ("PT1H2M3S" / "PT45M30.5S") → seconds.
function parseIsoDuration(v: unknown): number {
  if (typeof v !== "string") return 0;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(v);
  if (!m) return 0;
  return Math.round((+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)));
}

type PolarExercise = { id: string; summary?: Record<string, unknown>; gpx?: string | null };

// One Polar exercise → an ImportedRun, or null when it isn't a run/walk. Prefer
// the GPX (full route + HR series via the shared parser); fall back to the JSON
// summary's totals for a routeless (indoor) exercise.
export function polarExerciseToRun(ex: PolarExercise): ImportedRun | null {
  const s = ex.summary || {};
  const sport = String(s["detailed-sport-info"] ?? s["sport"] ?? "").toUpperCase();
  const isWalk = WALK_SPORTS.has(sport);
  const isRun = RUN_SPORTS.has(sport);
  // If the sport is known and not a run/walk, skip; if unknown, allow (a GPX/
  // distance still makes it importable — the user can re-type it).
  if (sport && !isWalk && !isRun) return null;
  const type = isWalk ? "WALK" : "EASY";
  const extId = "polar:" + ex.id;
  const startedAt = typeof s["start-time"] === "string" ? (s["start-time"] as string) : undefined;

  if (ex.gpx) {
    const res = parseActivityFile(ex.gpx, "gpx");
    if ("run" in res && res.run) {
      // Keep the parser's startedAt: GPX times are UTC ("Z"-suffixed), the
      // authoritative instant. Do NOT overwrite it with the summary's
      // `start-time`, which is timezone-naive local time (no offset) and would
      // shift the epoch — breaking time-overlap dedupe against a CSV/GPX copy.
      return {
        ...res.run,
        type,
        source: "watch",
        notes: "Imported from Polar",
        extId,
      };
    }
    // GPX unparseable — fall through to the summary.
  }

  const km = Math.round((Number(s["distance"]) || 0) / 1000 * 100) / 100;
  if (km < 0.05) return null; // no usable distance and no route
  const durationSec = parseIsoDuration(s["duration"]) || 0;
  const hrObj = (s["heart-rate"] || {}) as Record<string, unknown>;
  const date = startedAt ? startedAt.slice(0, 10) : "";
  if (!date) return null;
  return {
    date,
    type,
    km,
    durationSec,
    hr: hrObj["average"] != null ? Math.round(Number(hrObj["average"])) : null,
    hrMax: hrObj["maximum"] != null ? Math.round(Number(hrObj["maximum"])) : null,
    effort: 5,
    source: "watch",
    notes: "Imported from Polar",
    extId,
    ...(startedAt ? { startedAt } : {}),
  };
}

export const polarProvider: ImportProvider = {
  id: "polar",
  label: "Polar",
  kind: "cloud",
  // Web + native: web uses the full-page redirect; native opens the system
  // browser and gets the return bounced to the polar-callback deep link (see
  // cloudOauth.ts). Still dormant everywhere until VITE_POLAR_CLIENT_ID
  // is set — native builds get it from release.yml's web-build env.
  platform: "both",
  isAvailable: () => polarEnabled,
  isConnected: async () => {
    if (!polarEnabled) return false;
    const res = await oauth.invoke<{ connected?: boolean }>({ action: "status" });
    return !!res?.connected;
  },
  connect: oauth.connect,
  disconnect: () => { void oauth.invoke({ action: "disconnect" }); },
  // Polar's transaction pull returns only new (un-consumed) exercises, so the
  // local run list / window aren't needed — the registry dedupes on extId.
  scan: async () => {
    if (!polarEnabled) return [];
    const res = await oauth.invoke<{ exercises?: PolarExercise[] }>({ action: "sync" });
    const exercises = res?.exercises || [];
    const out: ImportedRun[] = [];
    for (const ex of exercises) {
      if (!ex?.id) continue;
      const run = polarExerciseToRun(ex);
      if (run) out.push(run);
    }
    return out;
  },
  help:
    "Connect your Polar account to import finished runs (route, pace, elevation and " +
    "heart-rate) recorded on your Polar watch, even when you leave your phone at home.",
};
