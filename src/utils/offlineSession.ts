import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL } from "../config";

// Offline sign-in fallback. When the access token has expired and the refresh
// call can't reach the server (offline cold start), supabase-js PRESERVES the
// session in storage but getSession() still resolves `session: null` — which
// used to drop a signed-in runner on the login screen for lack of a network.
// This reads the session supabase-js itself persisted and hands it to App.tsx
// as a UI-gating session only: supabase-js keeps its own internal state, so the
// next successful refresh (auto-refresh once back online) replaces it with a
// real one, and a genuine sign-out clears the storage slot so there is nothing
// to fall back to.

// How long after its access token expired a stored session still opens the app
// offline. The refresh token itself doesn't expire, so this is the product
// bound: "signed in recently" means active within the last week.
export const OFFLINE_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// supabase-js's default storage key: sb-<project-ref>-auth-token (the ref is
// the URL's first hostname label). Derived, not hardcoded, so it tracks the
// configured project.
export const supabaseStorageKey = (url: string) =>
  `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;

// Pure core, testable without storage: parse the persisted auth slot and
// accept it only when it still identifies a user and was live recently enough.
export function offlineSessionFromRaw(raw: string | null, now: number): Session | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Session;
    if (!s || typeof s !== "object" || !s.user?.id || !s.refresh_token) return null;
    if (typeof s.expires_at !== "number") return null;
    if (s.expires_at * 1000 < now - OFFLINE_SESSION_MAX_AGE_MS) return null; // idle too long
    return s;
  } catch {
    return null;
  }
}

export function readOfflineSession(): Session | null {
  try {
    return offlineSessionFromRaw(localStorage.getItem(supabaseStorageKey(SUPABASE_URL)), Date.now());
  } catch {
    return null;
  }
}
