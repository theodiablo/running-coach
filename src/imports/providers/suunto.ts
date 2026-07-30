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
});

export const suuntoEnabled = oauth.enabled;
export const expectedSuuntoStates = oauth.expectedStates;
export const completeSuuntoAuth = oauth.completeAuth;

const EXT_PREFIX = "suunto:";
// 10 pages × up to 50 summaries ≈ 500 workouts walked per scan; FITs download
// one call each, so the wall-clock cap is really the per-run fit calls. A
// larger history continues across scans (backfillPending exempts the
// once-per-session auto-scan gate in RunningCoach).
const MAX_PAGES_PER_SCAN = 10;

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
type FitRes = { error?: string; fit?: string; gone?: boolean; transient?: boolean };

function b64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}

// One Suunto workout (summary + optional FIT bytes) → an ImportedRun, or null
// when unusable. FIT wins (full route + HR series via the shared parser, which
// derives distance/elevation/startedAt from the trace exactly like a live
// run); the summary covers indoor/FIT-less workouts.
export function suuntoWorkoutToRun(w: SyncWorkout, fitB64: string | null): ImportedRun | null {
  const s = w.summary || {};
  const activityId = s.activityId != null && !Number.isNaN(Number(s.activityId)) ? Number(s.activityId) : null;
  const type = activityId != null && WALK_ACTIVITY_IDS.has(activityId) ? "WALK" : "EASY";
  const extId = EXT_PREFIX + w.key;

  if (fitB64) {
    const bytes = b64ToBytes(fitB64);
    if (bytes) {
      const res = parseFitFile(bytes);
      if ("run" in res && res.run) {
        // Keep the parser's startedAt: FIT timestamps are UTC, the
        // authoritative instant. Do NOT overwrite it from the summary — the
        // Polar lesson (see polarExerciseToRun): a shifted epoch breaks
        // time-overlap dedupe against another copy of the same run.
        return {
          ...res.run,
          type,
          source: "watch",
          notes: "Imported from Suunto",
          extId,
        };
      }
    }
    // Undecodable/unparseable FIT — fall through to the summary.
  }

  const km = Math.round((Number(s.totalDistance) || 0) / 1000 * 100) / 100;
  if (km < 0.05) return null; // no usable distance and no route
  const startMs = Number(s.startTime) || w.startTime || 0;
  if (!startMs) return null;
  // Unlike Polar's timezone-naive summary timestamps, Suunto's startTime is a
  // UTC epoch — set startedAt so time-overlap dedupe works even without a FIT
  // (the treadmill-run-recorded-twice case). The calendar date uses the
  // watch-local clock via timeOffsetInMinutes.
  const offsetMin = Number(s.timeOffsetInMinutes) || 0;
  const date = new Date(startMs + offsetMin * 60_000).toISOString().slice(0, 10);
  const hr = s.avgHeartRate != null ? Math.round(Number(s.avgHeartRate)) : null;
  const hrMax = s.maxHeartRate != null ? Math.round(Number(s.maxHeartRate)) : null;
  return {
    date,
    type,
    km,
    durationSec: Math.round(Number(s.totalTime) || 0),
    hr: Number.isFinite(hr as number) ? hr : null,
    hrMax: Number.isFinite(hrMax as number) ? hrMax : null,
    effort: 5,
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

// Fetch one workout's FIT and map it. "transient" = stop the batch here — the
// pending ack must never pass an unfetched listed workout (quota, token or
// network trouble resolves by the next scan; marking it terminal would import
// a permanently degraded summary-only run).
async function fetchWorkoutRun(w: SyncWorkout): Promise<ImportedRun | null | "transient"> {
  const res = await oauth.invoke<FitRes>({ action: "fit", key: w.key });
  if (!res || res.error) return "transient";
  if (res.transient) return "transient";
  const fitB64 = typeof res.fit === "string" ? res.fit : null; // gone → summary fallback
  return suuntoWorkoutToRun(w, fitB64);
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

      for (const w of listed) {
        const run = await fetchWorkoutRun(w);
        if (run === "transient") { stopped = true; break; }
        if (run) out.push(run);
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
          if (run) out.push(run);
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
    }
    backfillPending = true; // page cap hit with more behind — continue next scan
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
  disconnect: () => { void oauth.invoke({ action: "disconnect" }); },
  // The server-side cursor decides what's new — the `days` window doesn't
  // apply (like Polar's transaction pull); `runs` feeds knownKeys so already-
  // imported workouts are skipped before their FIT is ever downloaded.
  scan,
  help:
    "Connect your Suunto account to import finished runs (route, pace, elevation and " +
    "heart-rate) recorded on your Suunto watch, even when you leave your phone at home. " +
    "Your full history imports when you first connect.",
};
