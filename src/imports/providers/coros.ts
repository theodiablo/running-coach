import { parseFitFile } from "../../utils/fit";
import { makeCloudOauth } from "../cloudOauth";
import type { ImportProvider, ImportedRun } from "../types";
import type { Run } from "../../types";

// COROS cloud import — the third provider on the seam Polar opened and Suunto
// generalised (docs/integrations-polar.md, docs/integrations-suunto.md).
// Secret half (OAuth exchange, token refresh, workout listing, activity-file
// download) lives in the `coros-import` edge function; this client pages
// summaries, fetches one file per invocation and maps them with the app's own
// parser, exactly like Suunto.
//
// SHIPPED DORMANT, AND NOT ONLY FOR WANT OF A CLIENT ID. COROS publishes no
// technical API documentation before a developer application is approved: the
// public help centre describes the onboarding process and states the API is
// OAuth 2.0, and nothing else — no authorization URL, no scopes, no endpoints,
// no field names. Those arrive with the credentials. So the request shapes
// below are PLACEHOLDERS, not guesses, and `API_DOCUMENTED` keeps the provider
// unavailable until a human replaces them from the real API pack. Setting
// VITE_COROS_CLIENT_ID alone must NOT be able to arm it — see the note on that
// constant. Background and the full checklist: docs/integrations-coros.md.
//
// Why the discipline: Suunto shipped against inferred endpoints and needed two
// follow-up fixes (#202, #203) for a sync that reported "no new runs" and
// imports that arrived with no route — with real credentials and a live account
// to test against. A wrong endpoint never looks like an endpoint error from the
// app; it looks like "nothing new". Guessing blind would be strictly worse.

const COROS_CLIENT_ID = import.meta.env?.VITE_COROS_CLIENT_ID as string | undefined;

// TODO(coros-api): fill both in from the COROS API pack issued at onboarding,
// then flip API_DOCUMENTED. Deliberately EMPTY rather than plausible: an empty
// string can only fail loudly, while a wrong-but-well-formed URL would ship a
// provider that authorizes against nothing and reports "no new runs" forever.
const AUTH_URL = "";
const SCOPE = "";

// The arming switch. Typed `boolean` (not inferred `false`) so the guards below
// read as ordinary runtime checks rather than dead branches the compiler prunes.
const API_DOCUMENTED: boolean = false;

const oauth = makeCloudOauth({
  provider: "coros",
  authUrl: AUTH_URL,
  // Gated on BOTH the config AND the calibration flag. Passing the id through
  // only once the endpoints are real means `enabled` is false today, so
  // connect() returns false before it could parse the empty AUTH_URL, and
  // completeAuth() is "idle" on every load.
  clientId: API_DOCUMENTED ? COROS_CLIENT_ID : undefined,
  scope: SCOPE,
  // New provider, never shipped without it: PKCE from the start, like Suunto.
  // (Whether COROS's authorization server supports S256 is itself unconfirmed —
  // one more thing to check against the API pack before flipping the flag.)
  pkce: true,
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

// What `coros-import` returns per workout. This is OUR shape, not COROS's:
// the edge function's normalizeWorkout() is the single place that knows the
// vendor's field names, so the moment the API pack lands exactly one server
// function changes and everything below — including the tested mapper — is
// already correct. (Suunto reads vendor field names client-side because its
// summaries arrive from two differently-shaped sources; COROS has no such
// constraint, and normalising at the edge keeps the unknown in one file.)
export type CorosSummary = {
  distanceM?: number | null;
  durationSec?: number | null;
  avgHr?: number | null;
  maxHr?: number | null;
  ascentM?: number | null;
  // Minutes to add to UTC to get the watch's local clock, for the calendar date.
  utcOffsetMin?: number | null;
  // Already collapsed to the two kinds the app stores; the server drops
  // everything else before it ever reaches a download.
  sport?: "run" | "walk" | null;
};

export type CorosWorkout = {
  key: string;
  startTime: number; // epoch ms, UTC
  staged: boolean;
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

// Heart rate is stored as a whole number of bpm, and a 0 average means "the
// watch recorded none", not a real reading. (No unit conversion here: Suunto
// needs one because its API documents heart rate in Hz in places. Whether
// COROS reports anything in non-obvious units is unknown until the API pack
// lands — one more thing normalizeWorkout owns, not a guess to make here.)
const bpm = (v: number | null | undefined): number | null => {
  const n = num(v);
  return n == null || n <= 0 ? null : Math.round(n);
};

// One normalised COROS workout (+ optional activity-file bytes) → an
// ImportedRun, or null when unusable. The file wins when it parses (full route
// + HR series through the shared parser, which derives distance, elevation and
// startedAt from the trace exactly like a live run); the summary covers
// treadmill workouts and anything whose file failed to arrive.
//
// The file is assumed to be FIT, which is what COROS watches record and what
// `parseFitFile` already handles. UNCONFIRMED for the API: if the pack says the
// export is GPX or TCX, this branch routes through `parseActivityFile` instead
// (the app parses both) — one branch to change, and the summary fallback below
// keeps runs importing meanwhile. Never parse it server-side.
export function corosWorkoutToRun(w: CorosWorkout, fileB64: string | null): ImportedRun | null {
  const s = w.summary || {};
  const type = s.sport === "walk" ? "WALK" : "EASY";
  const extId = EXT_PREFIX + w.key;
  const offsetMin = num(s.utcOffsetMin);
  const sHr = bpm(s.avgHr);
  const sHrMax = bpm(s.maxHr);
  const sAscent = num(s.ascentM);
  // Calendar date on the WATCH's clock, consistent across both branches: the
  // parser's date is phone-local, which disagrees near midnight when the run
  // happened in another timezone (and would then miss the plan auto-tick).
  const localDate = (utcMs: number) =>
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
          // A file without record-level HR (no strap) or without barometric
          // altitude still keeps whatever the summary carried.
          hr: res.run.hr ?? sHr,
          hrMax: res.run.hrMax ?? sHrMax,
          ...(res.run.elevation == null && sAscent != null ? { elevation: Math.round(sAscent) } : {}),
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
    hr: sHr,
    hrMax: sHrMax,
    ...(sAscent != null ? { elevation: Math.round(sAscent) } : {}),
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
  const res = await oauth.invoke<FileRes>({ action: "file", key: w.key });
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

      // The tripwire. A full page fetched fine but EVERY workout mapped to
      // null: that is a normalisation mismatch, not a string of sub-50 m
      // workouts. Acking would silently consume the backfill while importing
      // nothing, so stop WITHOUT folding this page into the ack — the pages
      // re-serve once normalizeWorkout is fixed. For a provider whose payload
      // shape has never been seen live, this is the safeguard that turns a
      // wrong field name into a log line instead of a silently eaten history.
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
    "Your full history imports when you first connect.",
};
