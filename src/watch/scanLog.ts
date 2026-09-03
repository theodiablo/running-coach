import { WATCH_SCAN_LOG_KEY, WATCH_SCAN_LOG_MAX, WATCH_DEBUG_KEY } from "../constants";
import type { WatchImportAvailability, RouteReadStatus } from "./plugin";
import type { ClassifiedSession, SessionOutcome } from "./mapping";

// Developer diagnostics for watch import. Every Health Connect scan records what
// the store returned and why each session was kept or dropped, so "my Zepp run
// didn't show up" (or "its elevation is blank") can be diagnosed without a native
// debugger. Per-device only (like the auth/seen markers) — never in the synced
// blob — and bounded to a small ring buffer. Guarded like getSeenIds: storage
// failures are non-fatal and never throw into a scan.

export type ScanLogSession = {
  id: string;
  dataOrigin?: string;            // source app package (com.huami.watch.newsport = Zepp, etc.)
  exerciseType?: number;          // Health Connect ExerciseSessionRecord type id
  startTime?: string;
  distanceM?: number | null;
  elevationGainM?: number | null; // null here = the watch app wrote no elevation to HC
  activeSec?: number | null;
  hrAvg?: number | null;
  outcome: SessionOutcome;
};

export type ScanLogEntry = {
  at: number;                     // epoch ms of the scan
  trigger: string;                // "auto" | "manual"
  days: number;                   // window scanned
  availability: WatchImportAvailability | "skipped";
  permission: boolean;            // exercise-read grant present at scan time
  // The SEPARATE exercise-routes grant, which the user makes in Health Connect
  // rather than from our sheet — false is the normal state of a working
  // connection, and nothing gates on it. Recorded so "I allowed routes and still
  // get no map" can be told apart from "I never allowed them".
  routesGranted?: boolean;
  rawCount: number;               // sessions Health Connect returned
  importedCount: number;
  error?: string;
  sessions: ScanLogSession[];
  // Per-imported-run route outcome, in importedCount order. Absent when the scan
  // imported nothing. All "consent-required" is the expected default (exercise
  // routes are granted in Health Connect, not from our sheet); "none" means the
  // writing app attached no route to that session.
  routeStatuses?: RouteReadStatus[];
};

export function getScanLog(): ScanLogEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(WATCH_SCAN_LOG_KEY) || "[]");
    return Array.isArray(raw) ? (raw as ScanLogEntry[]) : [];
  } catch { return []; }
}

// Append newest-last, keeping the most recent WATCH_SCAN_LOG_MAX entries.
export function appendScanLog(entry: ScanLogEntry) {
  try {
    const next = getScanLog();
    next.push(entry);
    localStorage.setItem(WATCH_SCAN_LOG_KEY, JSON.stringify(next.slice(-WATCH_SCAN_LOG_MAX)));
  } catch { /* storage unavailable — non-fatal */ }
}

export function clearScanLog() {
  try { localStorage.removeItem(WATCH_SCAN_LOG_KEY); }
  catch { /* non-fatal */ }
}

// Trim classified sessions to the fields the log shows (raw, brand-agnostic).
export function toLogSessions(classified: ClassifiedSession[]): ScanLogSession[] {
  return classified.map(c => ({
    id: c.raw.id,
    dataOrigin: c.raw.dataOrigin,
    exerciseType: c.raw.exerciseType,
    startTime: c.raw.startTime,
    distanceM: c.raw.distanceM ?? null,
    elevationGainM: c.raw.elevationGainM ?? null,
    activeSec: c.raw.activeSec ?? null,
    hrAvg: c.raw.hrAvg ?? null,
    outcome: c.outcome,
  }));
}

// Hidden reveal for the Settings sync-log panel (tap the Integrations title a few
// times). Per-device flag; there is nothing sensitive behind it, it just keeps
// raw type ids / package names out of the normal UI.
export function isWatchDebugEnabled(): boolean {
  try { return localStorage.getItem(WATCH_DEBUG_KEY) === "1"; }
  catch { return false; }
}

export function setWatchDebug(on: boolean) {
  try {
    if (on) localStorage.setItem(WATCH_DEBUG_KEY, "1");
    else localStorage.removeItem(WATCH_DEBUG_KEY);
  } catch { /* non-fatal */ }
}
