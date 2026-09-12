// The standing share link — claiming it, replacing it, and caching it.
//
// Split from ./shareLink because this half needs the Supabase client and the
// public /watch page must never load one (see that module's header).
//
// The ledger (`live_share_tokens`) is the source of truth and the CLAIM is what
// makes a durable link safe: the token's uniqueness is held permanently by the
// runner, so no one handed the link can squat it and point the address at their
// own run. Retired tokens are kept server-side forever for the same reason.
// Detail: docs/live-sharing.md.

import { supabase } from "../supabase";
import { currentUserId } from "../db";
import { LIVE_SHARE_LINK_KEY } from "../constants";
import { isValidShareToken, mintShareToken } from "./shareLink";

// Two distinct 23505s, two different answers — the same idiom as the
// publisher's `conflictIndex`. The active-row index means another device (or
// tab) claimed a link first, so re-read theirs; the primary key means a 128-bit
// collision, so re-mint. Anything else is not ours to interpret.
type DbError = { code?: string | null; message?: string } | null;
const conflict = (err: DbError): "active" | "token" | "other" | null => {
  if (err?.code !== "23505") return null;
  const msg = String(err.message || "");
  if (msg.includes("live_share_tokens_active_key")) return "active";
  if (msg.includes("live_share_tokens_pkey")) return "token";
  return "other";
};

// ── The per-device cache ────────────────────────────────────────────────────
// A copy of confirmed server state so the panel can render the link with no
// connection. Keyed by uid: the next account on a shared device must never see
// the previous runner's address.

type CachedLink = { uid: string; token: string };

export const readCachedShareLink = (uid: string | null): string | null => {
  if (!uid) return null;
  try {
    const raw = localStorage.getItem(LIVE_SHARE_LINK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedLink>;
    if (parsed?.uid !== uid || !isValidShareToken(parsed?.token)) return null;
    return parsed.token as string;
  } catch { return null; }
};

const cacheShareLink = (uid: string, token: string): void => {
  try { localStorage.setItem(LIVE_SHARE_LINK_KEY, JSON.stringify({ uid, token })); }
  catch { /* quota — the link just won't render offline */ }
};

// Account data, so an explicit sign-out spends it (App.tsx), like the offline
// state mirror. Never called on a transient null session.
export const clearShareLinkCache = (): void => {
  try { localStorage.removeItem(LIVE_SHARE_LINK_KEY); } catch { /* ignore */ }
};

// ── Reading and claiming ────────────────────────────────────────────────────

const readActive = async (uid: string): Promise<{ token: string | null; failed: boolean }> => {
  const { data, error } = await supabase
    .from("live_share_tokens")
    .select("token")
    .eq("user_id", uid)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) return { token: null, failed: true };
  const token = typeof data?.token === "string" && isValidShareToken(data.token) ? data.token : null;
  return { token, failed: false };
};

// The account's active link, read from the ledger and cached. `null` means we
// could not establish one — offline, or the migration isn't applied yet — and
// the caller must keep showing whatever the cache already held rather than
// treating it as "no link".
export async function fetchShareLink(): Promise<string | null> {
  const uid = currentUserId();
  if (!uid) return null;
  const { token } = await readActive(uid);
  if (token) cacheShareLink(uid, token);
  return token;
}

// Claim a link if the account has none. Never called implicitly: creating one
// is an explicit act the runner confirms, because it is the moment a permanent
// address starts existing.
export async function ensureShareLink(): Promise<string | null> {
  const uid = currentUserId();
  if (!uid) return null;
  const existing = await readActive(uid);
  if (existing.token) { cacheShareLink(uid, existing.token); return existing.token; }
  // A read that FAILED is not an empty ledger: inserting here could claim a
  // second link for an account that already has one.
  if (existing.failed) return null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const token = mintShareToken();
    const { error } = await supabase.from("live_share_tokens").insert({ user_id: uid, token });
    if (!error) { cacheShareLink(uid, token); return token; }
    const kind = conflict(error);
    if (kind === "token") continue; // astronomically unlikely; re-mint
    if (kind === "active") {
      const raced = await readActive(uid);
      if (raced.token) cacheShareLink(uid, raced.token);
      return raced.token;
    }
    return null;
  }
  return null;
}

// Replace the link: the old address stops resolving for everyone holding it,
// server-side and at once — no wait for the runner's next publish.
//
// One RPC because it is two statements that must commit together: PostgREST
// gives every request its own transaction, so a client-side revoke-then-insert
// can leave the account with no link at all. The function is `security
// invoker`; the token below still comes from this device's CSPRNG.
export type RotateResult = { token: string | null; limit?: boolean };

export async function rotateShareLink(): Promise<RotateResult> {
  const uid = currentUserId();
  if (!uid) return { token: null };
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = mintShareToken();
    const { data, error } = await supabase.rpc("rotate_share_link", { p_new_token: token });
    if (!error) {
      const row = (Array.isArray(data) ? data[0] : data) as { token?: unknown } | null;
      const claimed = typeof row?.token === "string" && isValidShareToken(row.token) ? row.token : token;
      cacheShareLink(uid, claimed);
      return { token: claimed };
    }
    if (conflict(error) === "token") continue;
    // The ledger's per-account ceiling. Reported on its own, because "check
    // your connection" is wrong twice over: nothing is wrong with it, and
    // retrying never clears this.
    if (error.code === "P0001") return { token: null, limit: true };
    return { token: null };
  }
  return { token: null };
}
