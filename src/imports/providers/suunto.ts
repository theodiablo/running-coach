import { parseFitFile } from "../../utils/fit";
import { makeCloudOauth } from "../cloudOauth";
import type { ImportProvider, ImportedRun } from "../types";
import type { Run } from "../../types";

// Suunto cloud import. Secret half (OAuth exchange, token refresh, workout
// list, FIT download, webhook staging) lives in the `suunto-import` /
// `suunto-webhook` edge functions; this client pages summaries, fetches FITs
// one per invocation (each call stays inside the app's global 15s Supabase
// fetch timeout) and maps them to runs with the app's existing FIT parser.
// Dormant until VITE_SUUNTO_CLIENT_ID is set.
//
// The sync protocol is cursor + DEFERRED ack: scan() accumulates the ack for
// pages that produced candidate runs and only sends it when RunningCoach
// confirms the runs were saved (commitSuuntoScan, via registry
// commitCloudScans) — a missed import toast or a frozen WebView re-serves the
// page instead of losing history. Pages yielding nothing (all known/filtered)
// are acked immediately so a quiet history still advances the cursor.
// Architecture + cursor rules: docs/integrations-suunto.md.

const SUUNTO_CLIENT_ID = import.meta.env?.VITE_SUUNTO_CLIENT_ID as string | undefined;

const oauth = makeCloudOauth({
  provider: "suunto",
  authUrl: "https://cloudapi-oauth.suunto.com/oauth/authorize",
  clientId: SUUNTO_CLIENT_ID,
  scope: "workout",
  functionName: "suunto-import",
  pkce: true, // deep-link interception guard; opt-in so Polar's live URL is untouched
});

export const suuntoEnabled = oauth.enabled;
export const completeSuuntoAuth = oauth.completeAuth;

const EXT_PREFIX = "suunto:";
// While runs are pending a save the server cursor can't move, so real
// throughput is one server listing (~100 workouts) per user-confirmed scan —
// the loop breaks as soon as a page makes no progress. The 10-page cap only
// fast-forwards quiet history (all-filtered/known pages ack immediately, which
// DOES advance the cursor between pages). A larger history continues across
// scans (backfillPending exempts the once-per-session auto-scan gate in
// RunningCoach).
const MAX_PAGES_PER_SCAN = 10;
// Calibration tripwire: a full page whose every fetched workout maps to null
// smells like a summary-schema mismatch, not a string of sub-50 m workouts.
const ANOMALY_MIN_FETCHED = 3;
// Give up on a workout's FIT after this many scans blamed it specifically —
// its summary still imports, and the batch stops being wedged behind it.
const FIT_FAIL_LIMIT = 3;
const FIT_FAILS_KEY = "rc_suunto_fit_fails";
const FIT_FAILS_MAX = 50;
const RUN_CACHE_MAX = 200;

// Client mirror of the server's activity filter (suunto-import) — the server
// already dropped non-run/walk workouts, this only picks WALK vs EASY. Unknown
// or missing ids (staged payloads may be sparse) fall back to EASY; the user
// can re-type. CALIBRATE together with the server sets.
const WALK_ACTIVITY_IDS = new Set([1, 13, 24]);

type SyncWorkout = { key: string; startTime: number; staged: boolean; summary?: Record<string, unknown> };
type SyncRes = {
  connected?: boolean;
  error?: string;
  workouts?: SyncWorkout[];
  cursor?: number;
  stagedKeys?: string[];
  hasMore?: boolean;
};
type FitRes = { error?: string; fit?: string; gone?: boolean; transient?: boolean; quota?: boolean };

function b64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}

// First summary field that carries a finite number, or null. Suunto's payloads
// reach us from two places with different shapes — the workout listing and the
// webhook's trimmed body — so a field the app needs is read by every name it is
// known to arrive under rather than by one guess.
function summaryNum(s: Record<string, unknown>, ...names: string[]): number | null {
  for (const n of names) {
    if (s[n] == null) continue;
    const v = Number(s[n]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

// Suunto reports heart rate in Hz in parts of its API (beats per SECOND, so
// 2.7 means 162 bpm). No workout average is under 15 bpm, so a small value is
// always the Hz form — and importing "3 bpm" would poison the zones, the coach
// and every average that touches it.
function summaryBpm(v: number | null): number | null {
  if (v == null || v <= 0) return null;
  return Math.round(v < 15 ? v * 60 : v);
}

// One Suunto workout (summary + optional FIT bytes) → an ImportedRun, or null
// when unusable. FIT wins (full route + HR series via the shared parser, which
// derives distance/elevation/startedAt from the trace exactly like a live
// run); the summary covers indoor/FIT-less workouts.
export function suuntoWorkoutToRun(w: SyncWorkout, fitB64: string | null): ImportedRun | null {
  const s = w.summary || {};
  const activityId = summaryNum(s, "activityId");
  const type = activityId != null && WALK_ACTIVITY_IDS.has(activityId) ? "WALK" : "EASY";
  const extId = EXT_PREFIX + w.key;
  const offsetMin = summaryNum(s, "timeOffsetInMinutes");
  const sHr = summaryBpm(summaryNum(s, "avgHeartRate", "hravg"));
  const sHrMax = summaryBpm(summaryNum(s, "maxHeartRate", "hrmax"));
  const sAscent = summaryNum(s, "totalAscent", "ascent");
  // Calendar date in the WATCH-local clock, consistent across both branches —
  // the parser's date is phone-local, which disagrees near midnight when the
  // run happened in another timezone (and would miss plan auto-tick).
  const localDate = (utcMs: number) => new Date(utcMs + (offsetMin ?? 0) * 60_000).toISOString().slice(0, 10);

  if (fitB64) {
    const bytes = b64ToBytes(fitB64);
    if (bytes) {
      const res = parseFitFile(bytes);
      if ("run" in res && res.run) {
        const startedMs = res.run.startedAt ? Date.parse(res.run.startedAt) : NaN;
        // Keep the parser's startedAt: FIT timestamps are UTC, the
        // authoritative instant. Do NOT overwrite it from the summary — the
        // Polar lesson (see polarExerciseToRun): a shifted epoch breaks
        // time-overlap dedupe against another copy of the same run.
        return {
          ...res.run,
          ...(offsetMin != null && Number.isFinite(startedMs) ? { date: localDate(startedMs) } : {}),
          // A FIT without record-level HR (or barometric altitude) still keeps
          // the summary's values.
          hr: res.run.hr ?? sHr,
          hrMax: res.run.hrMax ?? sHrMax,
          ...(res.run.elevation == null && sAscent != null ? { elevation: Math.round(sAscent) } : {}),
          type,
          source: "watch",
          notes: "Imported from Suunto",
          extId,
        };
      }
    }
    // Undecodable/unparseable FIT — fall through to the summary.
  }

  const km = Math.round((summaryNum(s, "totalDistance", "distance") || 0) / 1000 * 100) / 100;
  if (km < 0.05) return null; // no usable distance and no route
  const startMs = summaryNum(s, "startTime") || w.startTime || 0;
  if (!startMs) return null;
  // Unlike Polar's timezone-naive summary timestamps, Suunto's startTime is a
  // UTC epoch — set startedAt so time-overlap dedupe works even without a FIT
  // (the treadmill-run-recorded-twice case).
  return {
    date: localDate(startMs),
    type,
    km,
    durationSec: Math.round(summaryNum(s, "totalTime") || 0),
    hr: sHr,
    hrMax: sHrMax,
    ...(sAscent != null ? { elevation: Math.round(sAscent) } : {}),
    effort: null,
    source: "watch",
    notes: "Imported from Suunto",
    extId,
    startedAt: new Date(startMs).toISOString(),
  };
}

// Ack accumulated across a scan's pages, sent only once RunningCoach confirms
// the imported runs were saved. Module state is fine: one scan runs at a time
// (scanAllProviders is sequential) and a stale pending ack is dropped at the
// next scan's start — the pages simply re-serve.
let pendingAck: { cursor: number; stagedKeys: string[] } | null = null;
let backfillPending = false;

export const suuntoBackfillPending = (): boolean => backfillPending;

export async function commitSuuntoScan(): Promise<void> {
  const p = pendingAck;
  pendingAck = null;
  if (!p || (!p.cursor && !p.stagedKeys.length)) return;
  await oauth.invoke({ action: "ack", cursor: p.cursor, stagedKeys: p.stagedKeys });
}

const progress = (fetched: number, done: boolean) => {
  try {
    window.dispatchEvent(new CustomEvent("rc-cloud-sync-progress", { detail: { id: "suunto", fetched, done } }));
  } catch { /* no window (tests) */ }
};

// Session-scoped cache of mapped runs (nulls included): a batch the user
// hasn't confirmed yet re-serves on the next scan, and without this every
// re-serve would re-download the same FITs and burn the daily quota.
const runCache = new Map<string, ImportedRun | null>();
const cacheRun = (key: string, run: ImportedRun | null): void => {
  if (runCache.size >= RUN_CACHE_MAX) {
    const oldest = runCache.keys().next().value;
    if (oldest !== undefined) runCache.delete(oldest);
  }
  runCache.set(key, run);
};

// Per-device count of scans a specific workout's FIT blamed for a stop —
// the retry budget that keeps one permanently broken workout from wedging the
// cursor (and everything recorded after it) forever.
function readFitFails(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(FIT_FAILS_KEY) || "{}");
    return v && typeof v === "object" ? v as Record<string, number> : {};
  } catch { return {}; }
}
function writeFitFails(m: Record<string, number>): void {
  try {
    const keys = Object.keys(m); // insertion order → drop-oldest
    while (keys.length > FIT_FAILS_MAX) delete m[keys.shift()!];
    localStorage.setItem(FIT_FAILS_KEY, JSON.stringify(m));
  } catch { /* storage unavailable — budget just doesn't persist */ }
}
const clearFitFailState = (): void => {
  try { localStorage.removeItem(FIT_FAILS_KEY); } catch { /* ignore */ }
};

// Fetch one workout's FIT and map it. "transient" = stop the batch here — the
// pending ack must never pass an unfetched listed workout (quota, token or
// network trouble resolves by the next scan; marking it terminal would import
// a permanently degraded summary-only run). Only server-reported transients
// that aren't the shared quota cap count against the workout's retry budget:
// quota/network/reauth are global conditions, a repeated per-workout failure
// (FIT_FAIL_LIMIT scans) means THIS workout is broken — import its summary and
// move on.
async function fetchWorkoutRun(w: SyncWorkout): Promise<ImportedRun | null | "transient"> {
  if (runCache.has(w.key)) return runCache.get(w.key) ?? null;
  const res = await oauth.invoke<FitRes>({ action: "fit", key: w.key });
  if (!res || res.error || res.transient) {
    const blamesWorkout = !!(res && res.transient && !res.quota && !res.error);
    if (blamesWorkout) {
      const fails = readFitFails();
      fails[w.key] = (fails[w.key] || 0) + 1;
      writeFitFails(fails);
      if (fails[w.key] >= FIT_FAIL_LIMIT) {
        console.warn("suunto fit given up after repeated failures", w.key);
        const run = suuntoWorkoutToRun(w, null);
        cacheRun(w.key, run);
        return run;
      }
    }
    return "transient";
  }
  const fitB64 = typeof res.fit === "string" ? res.fit : null; // gone → summary fallback
  const fails = readFitFails();
  if (w.key in fails) { delete fails[w.key]; writeFitFails(fails); } // a success resets the budget
  const run = suuntoWorkoutToRun(w, fitB64);
  cacheRun(w.key, run);
  return run;
}

async function scan(runs: Run[]): Promise<ImportedRun[]> {
  if (!suuntoEnabled) return [];
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
      if (!res || res.error || !res.connected || !Array.isArray(res.workouts)) return out;

      // Listed workouts ascending; their FITs download in order so the ack
      // cursor can stop exactly at the first transient failure.
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
        // Every listed workout was handled — the server cursor also covers the
        // ones it deliberately skipped (filtered/known), including trailing ones.
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
        // Every workout in the page was handled, so every staged key the
        // server listed is safe to drain — including ones that produced no
        // workout entry (already known / filtered) or rode along as listed.
        for (const k of res.stagedKeys || []) if (!ackStaged.includes(k)) ackStaged.push(k);
      }

      // Calibration tripwire: a full page fetched fine but EVERY workout
      // mapped to null — that's a summary-schema mismatch, not a string of
      // sub-50 m workouts. Acking would silently consume the backfill while
      // importing nothing; stop without folding this page into the ack.
      if (fetchedOk >= ANOMALY_MIN_FETCHED && mappedNull === fetchedOk) {
        console.warn(`suunto scan: page mapped 0/${fetchedOk} fetched workouts — possible schema mismatch, not acking`);
        return out;
      }

      const prev: { cursor: number; stagedKeys: string[] } = pendingAck || { cursor: 0, stagedKeys: [] };
      pendingAck = {
        cursor: Math.max(prev.cursor, ackCursor),
        stagedKeys: prev.stagedKeys.concat(ackStaged.filter(k => !prev.stagedKeys.includes(k))),
      };
      // While the scan has produced no candidate runs there is nothing for the
      // user to confirm — ack straight away so filtered/known pages advance the
      // cursor without interaction. Once a run is pending a save, every later
      // page's ack rides with it (a later ack's cursor would cover this page).
      if (out.length === 0) await commitSuuntoScan();

      if (stopped) return out;
      if (!res.hasMore) return out;
      // No progress this page and the server's watermark isn't moving (runs
      // pending → the cursor is frozen until the user confirms): every further
      // sync would re-list the same workouts. Stop instead of burning the
      // remaining pages on identical calls.
      const serverCursor = res.cursor || 0;
      if (out.length === outBefore && serverCursor <= lastServerCursor) return out;
      lastServerCursor = serverCursor;
    }
    // Page cap hit with more behind. Continuation only helps once the server
    // cursor can move again, so don't relax the auto-scan gate while an ack is
    // still waiting on the user's confirmation.
    backfillPending = pendingAck === null;
    return out;
  } finally {
    progress(out.length, true);
  }
}

export const suuntoProvider: ImportProvider = {
  id: "suunto",
  label: "Suunto",
  kind: "cloud",
  // Web + native, same shape as Polar: web full-page redirect; native system
  // browser bounced back via the suunto-callback deep link. Dormant everywhere
  // until VITE_SUUNTO_CLIENT_ID is set.
  platform: "both",
  isAvailable: () => suuntoEnabled,
  isConnected: async () => {
    if (!suuntoEnabled) return false;
    const res = await oauth.invoke<{ connected?: boolean }>({ action: "status" });
    return !!res?.connected;
  },
  connect: oauth.connect,
  disconnect: () => {
    // Reset all module sync state: a latched backfillPending would keep
    // relaxing the once-per-session auto-scan gate for the OTHER providers,
    // and a reconnect should start with a clean cache/retry budget.
    pendingAck = null;
    backfillPending = false;
    runCache.clear();
    clearFitFailState();
    void oauth.invoke({ action: "disconnect" });
  },
  // The server-side cursor decides what's new — the `days` window doesn't
  // apply (like Polar's transaction pull); `runs` feeds knownKeys so already-
  // imported workouts are skipped before their FIT is ever downloaded.
  scan,
  help:
    "Connect your Suunto account to import finished runs (route, pace, elevation and " +
    "heart-rate) recorded on your Suunto watch, even when you leave your phone at home. " +
    "Your full history imports when you first connect.",
};
