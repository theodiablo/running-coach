import { isAndroid } from "../native";
import { WATCH_HC_AUTH_KEY, WATCH_SEEN_HC_IDS_KEY, WATCH_SEEN_MAX } from "../constants";
import { getWatchImportPlugin, type WatchImportAvailability } from "./plugin";
import { classifyWatchSessions, type ClassifiedSession } from "./mapping";
import { appendScanLog, toLogSessions } from "./scanLog";
import { normalizeHrSamples } from "../imports/series";
import type { ImportedRun } from "../imports/types";
import type { Run } from "../types";

// Default rolling window scanned on each app open/foreground. No sync cursor:
// rescanning a fixed window (made idempotent by dedupe) naturally handles a watch
// that syncs to Health Connect hours or days after the run.
export const WATCH_SCAN_DAYS = 7;
// Wider window for the explicit "scan older runs" button in Settings. Health
// Connect refuses reads older than 30 days before the first grant anyway.
export const WATCH_MANUAL_SCAN_DAYS = 30;
// Minimum gap between empty AUTO scans (boot/foreground) — every scan is a full
// native Health Connect round-trip, and a watch takes minutes to sync anyway.
// Manual scans from Settings bypass this.
export const WATCH_AUTO_SCAN_COOLDOWN_MS = 5 * 60 * 1000;
// Ignore anything shorter than this — accidental start/stops, same threshold as
// the CSV import sanity filter.
export const WATCH_MIN_KM = 0.5;

const DAY_MS = 24 * 60 * 60 * 1000;

export function hasWatchAuthorization(): boolean {
  try { return localStorage.getItem(WATCH_HC_AUTH_KEY) === "1"; }
  catch { return false; }
}

export function setWatchAuthorization(ok: boolean) {
  try {
    if (ok) localStorage.setItem(WATCH_HC_AUTH_KEY, "1");
    else localStorage.removeItem(WATCH_HC_AUTH_KEY);
  } catch { /* storage unavailable — non-fatal */ }
}

// Health Connect session ids this device has already imported or dismissed.
// Per-device (an import is a local action) and capped so the list can't grow
// without bound. Survives the user deleting the imported run, so a deleted run
// is never re-offered.
export function getSeenIds(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(WATCH_SEEN_HC_IDS_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

export function markSeen(ids: string[]) {
  if (!ids?.length) return;
  try {
    const seen = new Set(getSeenIds());
    const next = getSeenIds();
    for (const id of ids) {
      if (id && !seen.has(id)) { seen.add(id); next.push(id); }
    }
    // Keep the most recent WATCH_SEEN_MAX (drop oldest first).
    localStorage.setItem(WATCH_SEEN_HC_IDS_KEY, JSON.stringify(next.slice(-WATCH_SEEN_MAX)));
  } catch { /* storage unavailable — non-fatal */ }
}

// Raw availability: "Available" | "NotInstalled" | "NotSupported". Any throw
// (plugin absent, older device, web) → "NotSupported".
export async function availability(): Promise<WatchImportAvailability> {
  try { return (await getWatchImportPlugin().checkAvailability())?.availability || "NotSupported"; }
  catch { return "NotSupported"; }
}

async function isAvailable() { return (await availability()) === "Available"; }

// Non-prompting permission check; keeps the local marker in sync with the real
// grant (clears it if the user revoked access in Health Connect).
async function checkPermissions(): Promise<boolean> {
  try {
    const ok = !!(await getWatchImportPlugin().checkHealthPermissions())?.granted;
    setWatchAuthorization(ok);
    return ok;
  } catch { setWatchAuthorization(false); return false; }
}

// Prompt for exercise/distance/elevation/HR read access. Returns whether granted.
async function requestPermissions(): Promise<boolean> {
  try {
    const ok = !!(await getWatchImportPlugin().requestHealthPermissions())?.granted;
    setWatchAuthorization(ok);
    return ok;
  } catch { setWatchAuthorization(false); return false; }
}

type ScanOptions = { enabled?: boolean; allowNativeRead?: boolean; days?: number; now?: number; trigger?: string };

// Read finished exercise sessions from Health Connect over the last `days`, map them to runs
// and drop anything already logged. Never throws, returns [] on failure. Touches the native
// bridge only when enabled AND this device holds the grant marker (grants are per-install).
// Every attempt, even skipped, is logged to the per-device scanLog; best-effort.
export async function scanWatchSessions(
  runs: Run[],
  { enabled = true, allowNativeRead = true, days = WATCH_SCAN_DAYS, now = Date.now(), trigger = "auto" }: ScanOptions = {},
): Promise<ImportedRun[]> {
  if (!isAndroid) return []; // web / iOS: nothing to scan or log
  if (!enabled || !allowNativeRead || !hasWatchAuthorization()) {
    // Preference on but this device not authorized (or reads deferred): log it so
    // "I connected but nothing imports" is diagnosable, then bail before the bridge.
    appendScanLog({ at: now, trigger, days, availability: "skipped", permission: false, rawCount: 0, importedCount: 0, sessions: [] });
    return [];
  }
  try {
    const avail = await availability();
    const perm = avail === "Available" ? await checkPermissions() : false;
    if (!perm) {
      appendScanLog({ at: now, trigger, days, availability: avail, permission: false, rawCount: 0, importedCount: 0, sessions: [] });
      return [];
    }
    const res = await getWatchImportPlugin().readExerciseSessions({
      startTime: new Date(now - days * DAY_MS).toISOString(),
      endTime: new Date(now).toISOString(),
    });
    const raw = res?.sessions || [];
    const classified = classifyWatchSessions(raw, runs || [], getSeenIds(), WATCH_MIN_KM);
    const importedC = classified.filter(c => c.outcome === "imported");
    // Enrich each NEW run with its raw HR series (for the detail time-in-zone
    // card) — one lazy per-run read, so an all-skipped scan does no extra I/O.
    const imported = await enrichWithHrSeries(importedC);
    appendScanLog({ at: now, trigger, days, availability: avail, permission: true, rawCount: raw.length, importedCount: imported.length, sessions: toLogSessions(classified) });
    return imported;
  } catch (e) {
    appendScanLog({ at: now, trigger, days, availability: "skipped", permission: false, rawCount: 0, importedCount: 0, error: String((e as { message?: string })?.message || e), sessions: [] });
    return [];
  }
}

// Fetch the raw HR series per imported session, origin-filtered to its writer, and attach it as
// hrSamples; a failed read leaves the avg/max aggregates. Health Connect has no route for any
// known writer, so these carry HR but no GPS: the run rides hrRouteId (persistImportedRoute).
async function enrichWithHrSeries(items: ClassifiedSession[]): Promise<ImportedRun[]> {
  return Promise.all(items.map(async ({ raw, run }): Promise<ImportedRun> => {
    const base = (run || {}) as ImportedRun;
    if (!raw?.startTime || !raw?.endTime) return base;
    try {
      const res = await getWatchImportPlugin().readHeartRateSeries({
        startTime: raw.startTime,
        endTime: raw.endTime,
        ...(raw.dataOrigin ? { dataOrigin: raw.dataOrigin } : {}),
      });
      const hrSamples = normalizeHrSamples(res?.samples);
      return hrSamples.length ? { ...base, hrSamples } : base;
    } catch { return base; }
  }));
}

// Surface for the Settings UI (connect flow + status), mirroring healthConnectSource.
export const watchImportSource = {
  id: "watchimport" as const,
  availability,
  isAvailable,
  checkPermissions,
  requestPermissions,
};
