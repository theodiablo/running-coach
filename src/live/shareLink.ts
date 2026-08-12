// Live-run share links — minting, URL shape, and the public read.
//
// The token IS the authorization: whoever holds the link may watch, and a
// signed-in visitor gets nothing extra. That is what keeps the public watch
// page a standalone leaf — it never touches the auth session or the store.
//
// The read below is a bare `fetch`, deliberately NOT supabase.functions.invoke:
// importing src/supabase.ts would spin up the auth client (localStorage, token
// refresh, a session read) on a page that has no business having a session. The
// anon key is public-safe on its own (src/config.ts) and the edge function is
// the only thing that can resolve a token anyway.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config";
import { LIVE_SHARE_TOKEN_KEY, WEB_APP_ORIGIN } from "../constants";
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

// 128 bits from the CSPRNG. Never Math.random(): a predictable token would make
// the whole design — where entropy, not obscurity, is what defeats crawling —
// silently worthless while still looking random.
export function mintShareToken(): string {
  const bytes = new Uint8Array(SHARE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

// The origin a shared link has to name. The shells serve the bundle from a local
// origin (https://localhost on Android, capacitor://localhost on iOS), so
// window.location.origin inside them is an address only that phone can open —
// it minted links like https://localhost/watch/<token>. The public page exists
// on the web deployment alone, and native builds don't even ship its chunk
// (main.tsx), so native names the web origin explicitly — the same rule as the
// Polar redirect_uri in src/imports/cloudOauth.ts.
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

// ── Per-device token storage ────────────────────────────────────────────────
// A minted token has to survive the app being killed mid-run: the recovered run
// republishes under the SAME token, so a link already sent to someone keeps
// working. Per-device (like LIVE_SHARE_KEY) because the broadcast is per-device
// — another phone's link is not this one's to reuse.

export const readShareToken = (): string | null => {
  try {
    const v = localStorage.getItem(LIVE_SHARE_TOKEN_KEY);
    return isValidShareToken(v) ? v : null;
  } catch { return null; }
};

export const storeShareToken = (token: string | null): void => {
  try {
    if (token) localStorage.setItem(LIVE_SHARE_TOKEN_KEY, token);
    else localStorage.removeItem(LIVE_SHARE_TOKEN_KEY);
  } catch { /* quota — the link just won't survive a restart */ }
};

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

export async function fetchLiveWatch(token: string, signal?: AbortSignal): Promise<WatchResult> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/functions/v1/live-watch?t=${encodeURIComponent(token)}`,
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
