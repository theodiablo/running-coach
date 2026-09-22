import {
  GEO_DIAG_LOG_KEY, GEO_DIAG_LOG_MAX, RUN_DIAG_LOG_KEY, RUN_DIAG_LOG_MAX,
  DIAG_LOG_HEAD, GEO_DEBUG_KEY,
} from "../constants";

// Developer diagnostics for what a run's sensor streams actually did — GPS and
// the live heart-rate link, on one timeline because they fail together and the
// question is always which of them stopped first.
//
// GPS: each fix that arrived from the native plugin, whether the tracker kept or
// dropped it (and why), when a gap was opened, permission results, and app
// foreground/background transitions. It answers "why did my track have an
// 11-minute hole with the screen off": if raw `native-fix` events keep landing
// while the app is `hidden`, the plugin is delivering and the filter is the
// culprit; if they stop, the OS/foreground service stopped feeding us.
//
// HR: the same question one layer at a time, because a strap that "connects and
// then stops reading" can be failing in any of four places and they are
// indistinguishable from the screen. `hr-beat` says whether notifications are
// still being DELIVERED to this JS; `hr-stall`'s `sinceMs` is the age of the
// last beat the NATIVE GATT callback saw, so a stall with a fresh native beat is
// a delivery stall and a stall with a stale one is a dead link; `hr-connect` and
// `hr-scan` say whether the reconnect that followed could get back in (and
// `hr-scan throttled` says Android's scan allowance is why it couldn't);
// `hr-save` closes the run with what actually survived to the run. Read them in
// that order and the failing layer names itself.
//
// Power: `power` rows say which regime the run recorded under — Battery Saver
// reaches the BLE link and the fix stream alike (docs/live-tracking.md).
//
// Per-device only (like the watch scan log and the auth markers) — never in the
// synced blob — and bounded to a small ring buffer. Guarded like getScanLog:
// storage failures are non-fatal and never throw into a hot geolocation or GATT
// notification callback.

export type GeoDiagKind =
  | "start"        // run start (Start button)
  | "stop"         // run stopped
  | "pause"
  | "resume"
  | "native-fix"   // a raw fix arrived from the geo source (BEFORE the tracker's filter)
  | "fix"          // fix accepted and stored
  | "drop"         // fix rejected by the tracker (msg = reason: too-soon / jitter / warmup / accuracy)
  | "gap"          // a gap marker was inserted (silence > GAP_MS)
  | "watch-start"  // native watcher added (msg = "background" | "foreground")
  | "watch-stop"
  | "perm"         // permission result (msg describes it, ok = granted)
  | "error"        // onErr fired (msg = message)
  | "visible"      // app returned to the foreground
  | "hidden"       // app went to the background (screen off / switched away)
  // ── live heart rate (src/hr/ble.ts) ──────────────────────────────────────
  | "hr-beat"      // roll-up of notifications DELIVERED to this JS (n = count, bpm = last)
  | "hr-status"    // watch status transition (msg = connecting/scanning/connected/unreachable)
  | "hr-connect"   // a connect attempt settled (ok = connected, msg = error text)
  | "hr-stall"     // the silence watchdog fired (msg = verdict, sinceMs = native beat age)
  | "hr-scan"      // re-discovery scan (msg = start / found / none / throttled)
  | "hr-journal"   // native HR journal armed/disarmed (msg = which)
  | "hr-save"      // save-time resolution (msg = live/journal/merged counts + coverage)
  // ── power regime (src/geo/battery.ts) ────────────────────────────────────
  | "power";       // what the OS was allowing at this moment (msg = saver=…)

export type GeoDiagEvent = {
  at: number;               // epoch ms the event was logged (wall clock)
  kind: GeoDiagKind;
  t?: number;               // fix timestamp (epoch ms), when different from `at`
  acc?: number | null;      // fix accuracy in metres
  sinceMs?: number;         // ms since the previous usable fix (for native-fix / fix / gap)
  ok?: boolean;             // permission granted (for "perm"), connected (for "hr-connect")
  msg?: string;             // freeform detail (drop reason, error text, watch mode)
  bpm?: number;             // last heart rate in the roll-up (for "hr-beat")
  n?: number;               // how many events this row stands for (for "hr-beat")
  seq?: number;             // write order — the key the two buffers are merged on
};

// Cache the reveal flag in-module so the per-fix instrumentation doesn't hit
// localStorage on every callback. Seeded lazily and kept current via setGeoDebug.
let enabled: boolean | null = null;

export function isGeoDebugEnabled(): boolean {
  if (enabled === null) {
    try { enabled = localStorage.getItem(GEO_DEBUG_KEY) === "1"; }
    catch { enabled = false; }
  }
  return enabled;
}

export function setGeoDebug(on: boolean) {
  enabled = on;
  try {
    if (on) localStorage.setItem(GEO_DEBUG_KEY, "1");
    else localStorage.removeItem(GEO_DEBUG_KEY);
  } catch { /* non-fatal */ }
}

// TWO buffers, not one: per-fix spam vs everything else, so a long run's fixes
// can't evict the rows that explain it (docs/live-tracking.md). Read as one
// timeline — getTrackLog merges them.
const FIX_KINDS: ReadonlySet<string> = new Set(["native-fix", "fix", "drop", "gap"]);

// Seeded past whatever is already stored: `seq` is the merge key, so a restart
// must not rewind it under rows still in the buffers.
let seq = -1;
function nextSeq(): number {
  if (seq < 0) {
    seq = 0;
    for (const e of [...read(GEO_DIAG_LOG_KEY), ...read(RUN_DIAG_LOG_KEY)])
      if ((e.seq ?? 0) >= seq) seq = (e.seq ?? 0) + 1;
  }
  return seq++;
}

// A plain FIFO evicts the head, and the head is `start` — so a session long
// enough to fill a buffer loses the one row saying when it began, which is
// exactly the session worth reading. Keep the oldest DIAG_LOG_HEAD rows and
// drop from the middle instead; the gap is implicit in the timestamps.
function trim(rows: GeoDiagEvent[], max: number): GeoDiagEvent[] {
  if (rows.length <= max) return rows;
  return [...rows.slice(0, DIAG_LOG_HEAD), ...rows.slice(rows.length - (max - DIAG_LOG_HEAD))];
}

function read(key: string): GeoDiagEvent[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(raw) ? (raw as GeoDiagEvent[]) : [];
  } catch { return []; }
}

// Merged, oldest-first, by write order. `seq` is the key rather than `at`,
// because a backwards wall-clock step mid-run (an NTP correction) would
// otherwise scramble the whole timeline. Pre-split rows carry no `seq`, but
// they live only in the fix buffer and predate every row that has one.
export function getTrackLog(): GeoDiagEvent[] {
  const fixes = read(GEO_DIAG_LOG_KEY), events = read(RUN_DIAG_LOG_KEY);
  const out: GeoDiagEvent[] = [];
  let i = 0, j = 0;
  while (i < fixes.length && j < events.length) {
    const a = fixes[i], b = events[j];
    const aFirst = a.seq != null && b.seq != null
      ? a.seq <= b.seq
      : (a.at || 0) <= (b.at || 0);
    out.push(aFirst ? fixes[i++] : events[j++]);
  }
  return out.concat(fixes.slice(i), events.slice(j));
}

// Append one event, newest-last, keeping the most recent rows up to its
// buffer's cap. A no-op unless logging is enabled, so normal runs pay nothing. Never throws — it is
// called from the geolocation callback and must not break recording. `at` is
// stamped here so call sites stay terse.
export function logTrack(kind: GeoDiagKind, extra: Omit<GeoDiagEvent, "at" | "kind"> = {}) {
  if (!isGeoDebugEnabled()) return;
  const fix = FIX_KINDS.has(kind);
  const key = fix ? GEO_DIAG_LOG_KEY : RUN_DIAG_LOG_KEY;
  const max = fix ? GEO_DIAG_LOG_MAX : RUN_DIAG_LOG_MAX;
  try {
    const next = read(key);
    next.push({ at: Date.now(), seq: nextSeq(), kind, ...extra });
    localStorage.setItem(key, JSON.stringify(trim(next, max)));
  } catch { /* storage unavailable / quota — non-fatal */ }
}

export function clearTrackLog() {
  try {
    localStorage.removeItem(GEO_DIAG_LOG_KEY);
    localStorage.removeItem(RUN_DIAG_LOG_KEY);
  } catch { /* non-fatal */ }
}
