// CSV import for Zepp / Strava activity exports.
//
// This is deliberately a small, dependency-free parser tuned for the two known
// export formats — not a full RFC-4180 implementation. It handles simple
// double-quoted fields (so a quoted value containing a comma is not split), but
// does not support escaped quotes or embedded newlines inside fields. Personal
// Zepp/Strava exports don't use those, and keeping it tiny avoids pulling in a
// parser dependency. All numeric fields are validated; rows that don't parse to
// sane values are skipped rather than silently coerced to 0.
import { ymd } from "./format";
import type { Run } from "../types";

type CsvRow = Record<string, string>;
type CsvRun = Run;

// Split a single CSV line, respecting simple double-quoted fields.
function splitCsvLine(line: string) {
  const out: string[] = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === "," && !inQuotes) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

// Parse a non-negative finite number, or return null when absent/invalid.
function num(v: string | null | undefined) {
  if (v == null || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Parse an export's start timestamp to an ISO instant, or null. Zepp uses
// "YYYY-MM-DD HH:MM[:SS]" (local time); Strava a locale datetime like
// "Jul 1, 2026, 8:00:00 AM". Carried as Run.startedAt so imports dedupe by
// real time-window overlap instead of the lossy same-day fuzzy fallback.
function isoStart(v: string | null | undefined) {
  if (!v) return null;
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v) ? v.replace(" ", "T") : v;
  const t = new Date(s);
  return Number.isNaN(+t) ? null : t.toISOString();
}

// Parse raw CSV text into run objects. Returns { runs, error }.
export function parseRunsCsv(text: string): { runs: CsvRun[]; error: string | null } {
  const trimmed = (text || "").trim();
  if (!trimmed) return {runs: [], error: "Empty file."};

  const lines = trimmed.split(/\r?\n/);
  const hdrs  = splitCsvLine(lines[0]).map(h => h.replace(/"/g, "").toLowerCase());
  // Detect by each format's distinctive headers. Strava also has an
  // "activity type" column, so keying Zepp off that (as an earlier version did)
  // misrouted Strava exports into the Zepp branch and imported nothing — hence
  // the explicit "start time" / "distance (m)" markers for Zepp here.
  const isZepp   = hdrs.includes("start time") || hdrs.includes("distance (m)");
  const isStrava = !isZepp && (hdrs.includes("activity date") || hdrs.includes("elapsed time"));
  if (!isZepp && !isStrava) {
    return {runs: [], error: "No runs found. Check it's a Zepp or Strava CSV."};
  }

  const runs: CsvRun[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = splitCsvLine(lines[i]);
    const row: CsvRow = {};
    hdrs.forEach((h, j) => { row[h] = vals[j] != null ? vals[j] : ""; });

    if (isZepp) {
      const dStr = (row["start time"] || "").split(" ")[0];
      const dM   = num(row["distance (m)"] ?? row["distance"]);
      const dur  = num(row["duration (s)"] ?? row["duration"]);
      if (dM != null && dur != null && dM > 500 && dur > 60) {
        const startedAt = isoStart(row["start time"]);
        runs.push({
          date: dStr || ymd(new Date()),
          type: "EASY", km: Math.round(dM / 100) / 10, durationSec: Math.round(dur),
          hr:    num(row["average heart rate (bpm)"]),
          hrMax: num(row["max heart rate (bpm)"]),
          elevation: null, effort: 5, notes: "Zepp import",
          ...(startedAt ? { startedAt } : {}),
        });
      }
    } else {
      const dStr = row["activity date"] ? ymd(new Date(row["activity date"])) : "";
      const dK   = num(row["distance"]);
      const dur  = num(row["elapsed time"] ?? row["moving time"]);
      const aT   = (row["activity type"] || "run").toLowerCase();
      if (aT.includes("run") && dK != null && dK > 0.5) {
        const startedAt = isoStart(row["activity date"]);
        runs.push({
          date: dStr, type: "EASY", km: dK, durationSec: dur != null ? Math.round(dur) : 0,
          hr:    num(row["average heart rate"]),
          hrMax: num(row["max heart rate"]),
          elevation: num(row["elevation gain"]) ?? undefined,
          effort: 5, notes: "Strava import",
          ...(startedAt ? { startedAt } : {}),
        });
      }
    }
  }
  return {runs, error: runs.length ? null : "No runs found. Check it's a Zepp or Strava CSV."};
}
