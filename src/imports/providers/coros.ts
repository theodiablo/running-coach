import { parseFitFile } from "../../utils/fit";
import { makeCloudOauth } from "../cloudOauth";
import type { ImportProvider, ImportedRun } from "../types";
import type { Run } from "../../types";

// COROS cloud import: the edge function `coros-import` holds the secret half;
// this client pages summaries and maps each .fit with the app's own parser.
// Calibrated against COROS API V2.0.6 but unverified live (dormant until
// VITE_COROS_CLIENT_ID). Date-range listing, no HR/elevation, a-z0-9 state: docs/integrations-coros.md.

const COROS_CLIENT_ID = import.meta.env?.VITE_COROS_CLIENT_ID as string | undefined;

// §3.1.2. COROS documents no `scope` parameter on the authorization endpoint,
// so the empty scope sends none (see buildAuthUrl).
const AUTH_URL = "https://open.coros.com/oauth2/authorize";
const SCOPE = "";

const oauth = makeCloudOauth({
  provider: "coros",
  authUrl: AUTH_URL,
  clientId: COROS_CLIENT_ID,
  scope: SCOPE,
  // No PKCE: COROS's token endpoint accepts no code_verifier (§3.2.3); the CSRF
  // guard is the nonce in `state`.
  pkce: false,
  functionName: "coros-import",
});

export const corosEnabled = oauth.enabled;
export const completeCorosAuth = oauth.completeAuth;

const EXT_PREFIX = "coros:";
const MAX_PAGES_PER_SCAN = 10;
// Calibration tripwire, the safeguard that matters most for a provider whose
// payload shape has never been seen: a full page fetched fine but mapped to
// nothing at all. See the scan loop.
const ANOMALY_MIN_FETCHED = 3;
const RUN_CACHE_MAX = 200;

// OUR shape, not COROS's: normalizeWorkout() in the edge function is the one
// place that knows vendor fields. Thin because the listing (§4.2.4) has no HR or
// elevation; those come only from the .fit.
export type CorosSummary = {
  distanceM?: number | null;
  durationSec?: number | null;
  // Minutes to add to UTC for the watch's local clock. COROS reports a
  // 15-minute-unit timezone (§4.2.4, 32 = UTC+08:00); the server converts.
  utcOffsetMin?: number | null;
  // Collapsed from COROS's mode/subMode pair (§4.2.4 workout type table); the
  // server drops every other sport before it reaches a download.
  sport?: "run" | "walk" | null;
};

export type CorosWorkout = {
  // COROS's `labelId` (§4.2.4).
  key: string;
  startTime: number; // epoch ms, UTC (COROS sends seconds; the server converts)
  staged: boolean;
  // Direct .fit download URL from the listing (§4.2.4 `fitUrl`). Passed back to
  // the edge function on the `file` call, which validates the host before
  // fetching. Absent when COROS listed no file for the workout.
  fitUrl?: string | null;
  summary?: CorosSummary;
};

type SyncRes = {
  connected?: boolean;
  error?: string;
  skipped?: string;
  workouts?: CorosWorkout[];
  cursor?: number;
  stagedKeys?: string[];
  hasMore?: boolean;
};
type FileRes = { error?: string; file?: string; gone?: boolean; transient?: boolean; quota?: boolean };

function b64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}

const num = (v: number | null | undefined): number | null =>
  v != null && Number.isFinite(Number(v)) ? Number(v) : null;

// One normalised workout (+ optional file bytes) → ImportedRun, or null. The file
// wins when it parses; the summary covers treadmill runs and missing files. The
// file is assumed FIT (unconfirmed for the API: GPX/TCX would route through
// parseActivityFile). Never parse it server-side.
export function corosWorkoutToRun(w: CorosWorkout, fileB64: string | null): ImportedRun | null {
  const s = w.summary || {};
  const type = s.sport === "walk" ? "WALK" : "EASY";
  const extId = EXT_PREFIX + w.key;
  const offsetMin = num(s.utcOffsetMin);
  // Calendar date on the WATCH's clock, consistent across both branches: the
  // parser's date is phone-local, which disagrees near midnight when the run
  // happened in another timezone (and would then miss the plan auto-tick).
  const localDate = (utcMs: number) =>
    // eslint-disable-next-line seams/no-iso-date-slice -- shifted by the run's own UTC offset first
    new Date(utcMs + (offsetMin ?? 0) * 60_000).toISOString().slice(0, 10);

  if (fileB64) {
    const bytes = b64ToBytes(fileB64);
    if (bytes) {
      const res = parseFitFile(bytes);
      if ("run" in res && res.run) {
        const startedMs = res.run.startedAt ? Date.parse(res.run.startedAt) : NaN;
        // Keep the parser's startedAt: FIT timestamps are UTC and are the
        // authoritative instant. Never overwrite it from the summary — a
        // shifted epoch breaks time-overlap dedupe against another copy of the
        // same run (the lesson polarExerciseToRun carries).
        return {
          ...res.run,
          ...(offsetMin != null && Number.isFinite(startedMs) ? { date: localDate(startedMs) } : {}),
          type,
          source: "watch",
          notes: "Imported from COROS",
          extId,
        };
      }
    }
    // Undecodable or unparseable file — fall through to the summary rather than
    // dropping the run.
  }

  const km = Math.round((num(s.distanceM) || 0) / 1000 * 100) / 100;
  if (km < 0.05) return null; // no usable distance and no route
  const startMs = w.startTime || 0;
  if (!startMs) return null;
  return {
    date: localDate(startMs),
    type,
    km,
    durationSec: Math.round(num(s.durationSec) || 0),
    // No HR and no elevation: COROS's listing carries neither (§4.2.4), so a
    // workout whose .fit never arrived imports as distance and duration only.
    hr: null,
    hrMax: null,
    effort: null,
    source: "watch",
    notes: "Imported from COROS",
    extId,
    // startTime is a UTC epoch, so time-overlap dedupe works even without a
    // file (the treadmill-run-recorded-twice case).
    startedAt: new Date(startMs).toISOString(),
  };
}

// Deferred ack, identical in spirit to Suunto's: the server cursor only moves
// once RunningCoach confirms the runs were actually saved, so a missed import
// toast or a frozen WebView re-serves the page instead of losing history.
let pendingAck: { cursor: number; stagedKeys: string[] } | null = null;
let backfillPending = false;

export const corosBackfillPending = (): boolean => backfillPending;

export async function commitCorosScan(): Promise<void> {
  const p = pendingAck;
  pendingAck = null;
  if (!p || (!p.cursor && !p.stagedKeys.length)) return;
  await oauth.invoke({ action: "ack", cursor: p.cursor, stagedKeys: p.stagedKeys });
}

const progress = (fetched: number, done: boolean) => {
  try {
    window.dispatchEvent(new CustomEvent("rc-cloud-sync-progress", { detail: { id: "coros", fetched, done } }));
  } catch { /* no window (tests) */ }
};

// Session-scoped cache of mapped runs (nulls included): a batch the user hasn't
// confirmed yet re-serves on the next scan, and without this every re-serve
// would re-download the same files against a metered API.
const runCache = new Map<string, ImportedRun | null>();
const cacheRun = (key: string, run: ImportedRun | null): void => {
  if (runCache.size >= RUN_CACHE_MAX) {
    const oldest = runCache.keys().next().value;
    if (oldest !== undefined) runCache.delete(oldest);
  }
  runCache.set(key, run);
};

// Fetch one workout's activity file and map it. "transient" = stop the batch
// here: the pending ack must never pass a workout we failed to fetch, because
// acking past it would import a permanently degraded summary-only run (or
// nothing) and the cursor would never come back for it.
async function fetchWorkoutRun(w: CorosWorkout): Promise<ImportedRun | null | "transient"> {
  if (runCache.has(w.key)) return runCache.get(w.key) ?? null;
  // No fitUrl in the listing means COROS has no file for this workout — go
  // straight to the summary rather than spending a call to be told so.
  if (!w.fitUrl) {
    const run = corosWorkoutToRun(w, null);
    cacheRun(w.key, run);
    return run;
  }
  const res = await oauth.invoke<FileRes>({ action: "file", key: w.key, fitUrl: w.fitUrl });
  if (!res || res.error || res.transient) return "transient";
  // `gone` (the workout genuinely has no file) → summary fallback.
  const fileB64 = typeof res.file === "string" ? res.file : null;
  const run = corosWorkoutToRun(w, fileB64);
  cacheRun(w.key, run);
  return run;
}

async function scan(runs: Run[]): Promise<ImportedRun[]> {
  if (!corosEnabled) return [];
  // A pending ack from a scan whose import was never confirmed is stale: drop
  // it, the same pages re-serve now and dedupe collapses them.
  pendingAck = null;
  backfillPending = false;
  const knownKeys = (runs || [])
    .map(r => r.extId)
    .filter((id): id is string => !!id && id.startsWith(EXT_PREFIX))
    .map(id => id.slice(EXT_PREFIX.length));
  const out: ImportedRun[] = [];
  let lastServerCursor = -1;
  try {
    for (let page = 0; page < MAX_PAGES_PER_SCAN; page++) {
      const res = await oauth.invoke<SyncRes>({ action: "sync", knownKeys });
      if (!res || res.error || res.skipped || !res.connected || !Array.isArray(res.workouts)) return out;

      // Listed workouts ascending, so the ack cursor can stop exactly at the
      // first transient failure.
      const listed = res.workouts.filter(w => !w.staged && w.key)
        .sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
      const stagedW = res.workouts.filter(w => w.staged && w.key);
      let ackCursor = 0;
      const ackStaged: string[] = [];
      let stopped = false;
      let fetchedOk = 0;
      let mappedNull = 0;
      const outBefore = out.length;

      for (const w of listed) {
        const run = await fetchWorkoutRun(w);
        if (run === "transient") { stopped = true; break; }
        fetchedOk++;
        if (run) out.push(run); else mappedNull++;
        knownKeys.push(w.key);
        ackCursor = Math.max(ackCursor, w.startTime || 0);
        progress(out.length, false);
      }
      if (!stopped) {
        // Every listed workout was handled, so the server cursor also covers
        // the ones it deliberately skipped (wrong sport, already known).
        ackCursor = Math.max(ackCursor, res.cursor || 0);
        for (const w of stagedW) {
          const run = await fetchWorkoutRun(w);
          if (run === "transient") { stopped = true; break; }
          fetchedOk++;
          if (run) out.push(run); else mappedNull++;
          knownKeys.push(w.key);
          ackStaged.push(w.key);
          progress(out.length, false);
        }
      }
      if (!stopped) {
        for (const k of res.stagedKeys || []) if (!ackStaged.includes(k)) ackStaged.push(k);
      }

      // Tripwire: a full page where EVERY workout mapped to null is a schema
      // mismatch. Don't ack it, or the backfill is silently consumed; the pages
      // re-serve once normalizeWorkout is fixed.
      if (fetchedOk >= ANOMALY_MIN_FETCHED && mappedNull === fetchedOk) {
        console.warn(`coros scan: page mapped 0/${fetchedOk} fetched workouts — possible schema mismatch, not acking`);
        return out;
      }

      const prev: { cursor: number; stagedKeys: string[] } = pendingAck || { cursor: 0, stagedKeys: [] };
      pendingAck = {
        cursor: Math.max(prev.cursor, ackCursor),
        stagedKeys: prev.stagedKeys.concat(ackStaged.filter(k => !prev.stagedKeys.includes(k))),
      };
      // Nothing for the user to confirm yet → ack straight away so filtered or
      // already-known pages advance the cursor without interaction.
      if (out.length === 0) await commitCorosScan();

      if (stopped) return out;
      if (!res.hasMore) return out;
      // No progress this page and the server's watermark isn't moving (runs are
      // pending a save, so the cursor is frozen): every further sync would
      // re-list the same workouts.
      const serverCursor = res.cursor || 0;
      if (out.length === outBefore && serverCursor <= lastServerCursor) return out;
      lastServerCursor = serverCursor;
    }
    // Page cap hit with more behind. Continuation only helps once the server
    // cursor can move again, so don't relax the auto-scan gate while an ack is
    // still waiting on the user.
    backfillPending = pendingAck === null;
    return out;
  } finally {
    progress(out.length, true);
  }
}

export const corosProvider: ImportProvider = {
  id: "coros",
  label: "COROS",
  kind: "cloud",
  // Web + native on the shared seam, same as Polar and Suunto. Dormant
  // everywhere until the API pack lands AND VITE_COROS_CLIENT_ID is set.
  platform: "both",
  isAvailable: () => corosEnabled,
  isConnected: async () => {
    if (!corosEnabled) return false;
    const res = await oauth.invoke<{ connected?: boolean }>({ action: "status" });
    return !!res?.connected;
  },
  connect: oauth.connect,
  disconnect: () => {
    pendingAck = null;
    backfillPending = false;
    runCache.clear();
    void oauth.invoke({ action: "disconnect" });
  },
  // The server-side cursor decides what's new, so the `days` window doesn't
  // apply; `runs` feeds knownKeys so already-imported workouts are skipped
  // before their file is ever downloaded.
  scan,
  help:
    "Connect your COROS account to import finished runs (route, pace, elevation and " +
    "heart rate) recorded on your COROS watch, even when you leave your phone at home. " +
    "COROS only serves the last three months, so older runs cannot be imported.",
};
