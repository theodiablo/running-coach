// Live-run share links: minting, URL shape, the public read, and the pure panel state.
// The token IS the authorization, so the public watch page stays a standalone leaf that never
// touches the auth session or store. Ledger code lives in ./shareLinkStore, and this module
// must never import src/supabase.ts: the read below is a bare `fetch` (anon key is public-safe).

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config";
import { WEB_APP_ORIGIN } from "../constants";
import { isNative } from "../native";
import type { LiveRunRow } from "./publisher";
// @ts-expect-error Shared Deno/Vitest ESM has no TypeScript declaration file.
import * as sharedLiveShare from "../../supabase/functions/_shared/liveShare.mjs";

type LiveShareExports = {
  SHARE_TOKEN_RE: RegExp;
  SHARE_TOKEN_BYTES: number;
  isValidShareToken: (value: unknown) => boolean;
  toBase64Url: (bytes: Uint8Array) => string;
};
const shared = sharedLiveShare as LiveShareExports;

export const { SHARE_TOKEN_RE, SHARE_TOKEN_BYTES, isValidShareToken, toBase64Url } = shared;

// Everything the public page renders. Structurally the live_runs row MINUS
// user_id — the edge function never returns it, so a viewer can't learn whose
// run this is (see supabase/functions/live-watch/index.ts).
export type PublicLiveRun = Omit<LiveRunRow, "user_id">;

export const WATCH_PATH_PREFIX = "/watch/";

// 128 bits from the CSPRNG, never Math.random(): a predictable token would silently void the
// design (entropy defeats crawling). Minted here and CLAIMED in the ledger (shareLinkStore),
// where the claim is permanent and first-come.
export function mintShareToken(): string {
  const bytes = new Uint8Array(SHARE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

// The origin a shared link must name. Shells serve from a local origin (https://localhost,
// capacitor://localhost) that only that phone can open, and native builds don't ship the public
// page (main.tsx), so native names the web origin explicitly, like the Polar redirect_uri
// in src/imports/cloudOauth.ts.
export const shareOrigin = (): string =>
  isNative || typeof window === "undefined" ? WEB_APP_ORIGIN : window.location.origin;

export const watchUrl = (token: string, origin: string = shareOrigin()): string =>
  `${origin}${WATCH_PATH_PREFIX}${token}`;

// The router, such as it is. Returns the token for a /watch/:token path and
// null for everything else, so main.tsx can branch before App mounts. Validates
// the shape here rather than in the page, so a junk path never reaches the
// network and a trailing slash or extra segment is simply not a watch URL.
export function parseWatchToken(pathname: string): string | null {
  if (!pathname.startsWith(WATCH_PATH_PREFIX)) return null;
  const token = pathname.slice(WATCH_PATH_PREFIX.length);
  return isValidShareToken(token) ? token : null;
}

// ── What the panel renders ──────────────────────────────────────────────────
// Pure and separate from the tracker: three inputs make four states, and a wrong pairing is a
// privacy bug (a link shown live while the run is private, or offered before the ledger
// confirms it).

export type ShareLinkState =
  // No link claimed yet: offer to create one (which is where the explainer is).
  | { kind: "none" }
  // A claim or a replacement is in flight.
  | { kind: "busy" }
  // `active` is whether THIS run is published to it; `sendable` is whether the
  // token has been confirmed against the ledger this session.
  | { kind: "link"; token: string; url: string; active: boolean; sendable: boolean };

export function shareLinkState(
  { token, sharing, busy = false, confirmed = false }:
  { token: string | null; sharing: boolean; busy?: boolean; confirmed?: boolean },
): ShareLinkState {
  if (busy) return { kind: "busy" };
  if (!token) return { kind: "none" };
  return { kind: "link", token, url: watchUrl(token), active: sharing, sendable: confirmed };
}

// ── The public read ─────────────────────────────────────────────────────────

export type WatchResult =
  // A run is being broadcast under this token right now.
  | { kind: "live"; run: PublicLiveRun }
  // The single answer for a bad token, a run that hasn't started, one that was
  // swept, and one too old to serve. The page must render all four identically
  // — that indistinguishability is the anti-probing property, and it is also
  // what makes sharing a link BEFORE the run work.
  | { kind: "none" }
  // Couldn't reach the server, or it failed. Distinct from "none" so the page
  // can keep the last trace on screen and retry instead of claiming the run is
  // over — a dropped connection must never read as a finished run.
  | { kind: "error"; retryAfterMs?: number };

// Random per page load and held in memory only: live-watch counts page loads that saw a run live
// (docs/product-metrics.md). Never stored, so it links nothing across loads or runs.
let viewerId: string | undefined;
export const watchViewerId = (): string => {
  try { viewerId ??= crypto.randomUUID(); } catch { viewerId = ""; }
  return viewerId;
};

export async function fetchLiveWatch(token: string, signal?: AbortSignal): Promise<WatchResult> {
  const v = watchViewerId();
  try {
    const res = await fetch(
      `${SUPABASE_URL}/functions/v1/live-watch?t=${encodeURIComponent(token)}${v ? `&v=${v}` : ""}`,
      {
        signal,
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      },
    );
    if (res.status === 429) {
      const secs = Number(res.headers.get("Retry-After"));
      return { kind: "error", retryAfterMs: Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined };
    }
    if (!res.ok) return { kind: "error" };
    const body = await res.json().catch(() => null) as { live?: boolean; run?: PublicLiveRun } | null;
    if (!body?.live || !body.run) return { kind: "none" };
    return { kind: "live", run: body.run };
  } catch {
    return { kind: "error" };
  }
}

// ── The batch read (following several runners) ──────────────────────────────

type TrackPointOrGap = PublicLiveRun["points"][number];

// What an unfocused runner costs: state, stats and where they are now. No
// trace: that is the whole saving (docs/live-sharing.md, "Following several
// runners").
export type WatchSummary = Omit<PublicLiveRun, "points"> & { head: TrackPointOrGap };

export type BatchRequestEntry = { token: string; full?: boolean; since?: string | null };

export type BatchEntryResult =
  | { kind: "none" }
  | { kind: "summary"; run: WatchSummary }
  | { kind: "full"; run: PublicLiveRun }
  // The full trace the caller already holds (its `since`) is still current.
  | { kind: "unchanged" };

export type BatchResult =
  | { kind: "ok"; results: BatchEntryResult[] }
  | { kind: "error"; retryAfterMs?: number };

function readBatchEntry(raw: unknown): BatchEntryResult | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as { live?: unknown; unchanged?: unknown; run?: Record<string, unknown> };
  if (e.live === false) return { kind: "none" };
  if (e.live !== true) return null;
  if (e.unchanged === true) return { kind: "unchanged" };
  if (!e.run || typeof e.run !== "object") return null;
  if (Array.isArray(e.run.points)) return { kind: "full", run: e.run as unknown as PublicLiveRun };
  return { kind: "summary", run: { ...(e.run as unknown as WatchSummary), head: (e.run.head ?? null) as TrackPointOrGap } };
}

// One POST for every followed runner. Anything but exactly one well-formed
// answer per entry is NOT read as "nobody is live": a function deployed before
// the batch existed answers a single `{ live: false }`, which is the one lie
// this page must never tell. That shape falls back to one read per token.
export async function fetchLiveWatchBatch(entries: BatchRequestEntry[], signal?: AbortSignal): Promise<BatchResult> {
  if (!entries.length) return { kind: "ok", results: [] };
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/live-watch`, {
      method: "POST",
      signal,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...(watchViewerId() ? { v: watchViewerId() } : {}),
        tokens: entries.map(e => ({ t: e.token, ...(e.full ? { full: true } : {}), ...(e.since ? { since: e.since } : {}) })),
      }),
    });
    if (res.status === 429) {
      const secs = Number(res.headers.get("Retry-After"));
      return { kind: "error", retryAfterMs: Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined };
    }
    if (!res.ok) return { kind: "error" };
    const body = await res.json().catch(() => null) as { runs?: unknown } | null;
    const results = Array.isArray(body?.runs) && body.runs.length === entries.length
      ? body.runs.map(readBatchEntry) : null;
    if (results && results.every(r => r !== null)) return { kind: "ok", results: results as BatchEntryResult[] };
    return await fetchEachLiveWatch(entries, signal);
  } catch {
    return { kind: "error" };
  }
}

async function fetchEachLiveWatch(entries: BatchRequestEntry[], signal?: AbortSignal): Promise<BatchResult> {
  const each = await Promise.all(entries.map(e => fetchLiveWatch(e.token, signal)));
  const failed = each.find(r => r.kind === "error");
  if (failed) return failed as BatchResult;
  return { kind: "ok", results: each.map(r => r.kind === "live" ? { kind: "full", run: r.run } : { kind: "none" }) };
}

// `/watch/` (and a bare `/watch`) is the follow list; `/watch/<token>` stays one
// runner. The trailing-slash form is canonical: it is the one CloudFront serves
// watch.html for, and robots.txt's `Disallow: /watch/` covers.
export const WATCH_LIST_PATH = WATCH_PATH_PREFIX;
export const isWatchListPath = (pathname: string): boolean => pathname === "/watch" || pathname === WATCH_PATH_PREFIX;

// A pasted link, or a bare token, → the token. Anything else → null.
export function tokenFromInput(value: string): string | null {
  const v = value.trim();
  if (isValidShareToken(v)) return v;
  try {
    return parseWatchToken(new URL(v, "https://x.invalid").pathname.replace(/\/+$/, ""));
  } catch {
    return null;
  }
}
