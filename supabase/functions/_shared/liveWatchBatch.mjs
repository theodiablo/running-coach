// The batch read behind "follow several runners" — the pure half, shared by the
// live-watch edge function (Deno) and Vitest. The function owns the database
// calls; everything that decides WHAT an entry says lives here, so the uniform
// `{ live: false }` rule is tested once and can't drift per call site.
// Detail: docs/live-sharing.md ("Following several runners").

import { isValidShareToken } from "./liveShare.mjs";

// One batch answers at most this many entries — the follow list's own cap.
export const BATCH_MAX = 10;
// Ten 64-char tokens plus a timestamp each fit in well under 2 KB.
export const BATCH_MAX_BODY = 4096;

// The last few points, read separately so a summary never drags the whole trace
// out of the database. A trace may END on a gap marker (recovery appends one),
// so the head is the last non-null of these; three covers a gap after a gap.
export const HEAD_COLUMNS = "h1:points->-1, h2:points->-2, h3:points->-3";

// Body → entries, or null for a malformed request (a 400, never a token answer).
// An entry with a bad token is kept: it answers `{ live: false }` like any miss.
export function parseBatchBody(text) {
  if (typeof text !== "string" || text.length > BATCH_MAX_BODY) return null;
  let body;
  try { body = JSON.parse(text); } catch { return null; }
  const list = body && Array.isArray(body.tokens) ? body.tokens : null;
  if (!list || !list.length || list.length > BATCH_MAX) return null;
  return list.map(e => ({
    t: typeof e?.t === "string" ? e.t : "",
    full: e?.full === true,
    since: typeof e?.since === "string" ? e.since : null,
  }));
}

export const validTokens = (entries) => [...new Set(entries.map(e => e.t).filter(isValidShareToken))];

export function pickHead(row) {
  for (const p of [row?.h1, row?.h2, row?.h3]) if (Array.isArray(p)) return p;
  return null;
}

// The gates a row must pass to be shown at all — the same ones the single read
// applies. `requireShare` is the ledger path's per-run opt-in; the legacy path
// carries its own (the token is on the row).
export function rowVisible(row, { requireShare, now, maxAgeMs }) {
  if (!row) return false;
  if (requireShare && row.share_public !== true) return false;
  const updated = Date.parse(String(row.updated_at));
  return Number.isFinite(updated) && now - updated <= maxAgeMs;
}

// A full trace is owed to the focused runner, and to any runner whose run has
// ended: Save deletes the row seconds after Stop, so a finished route not taken
// now is gone for good.
export const wantsFull = (entry, row) => entry.full || row.status === "ended";

// One entry's answer. `row` is the summary row (heads, no points), `fullRow`
// the points row when one was read. Both are re-gated: the two reads are
// separate statements, and the run may have been hidden in between.
export function answerEntry(entry, row, fullRow, gate) {
  if (!rowVisible(row, gate)) return { live: false };
  const base = { status: row.status, started_at: row.started_at, updated_at: row.updated_at, stats: row.stats ?? {} };
  if (!wantsFull(entry, row)) return { live: true, run: { ...base, head: pickHead(row) } };
  if (entry.since !== null && entry.since === row.updated_at) return { live: true, unchanged: true };
  if (!rowVisible(fullRow, gate)) return { live: false };
  return {
    live: true,
    run: {
      status: fullRow.status, started_at: fullRow.started_at, updated_at: fullRow.updated_at,
      stats: fullRow.stats ?? {}, points: fullRow.points ?? [],
    },
  };
}
