// Live-run share links — the one thing both ends must agree on.
//
// Plain ESM so it imports from Deno (the live-watch edge function) AND from
// Vitest/the browser bundle (src/live/shareLink.ts re-exports it), the same
// dual-import pattern as _shared/coach/styles.mjs. The token shape is a
// SECURITY parameter, not formatting: it is what makes crawling /watch/<guess>
// hopeless, so the client that mints it, the CHECK constraint that stores it,
// and the function that resolves it must not drift apart.

// base64url, 22 chars = the exact encoding of 16 random bytes (128 bits) with
// no padding. The upper bound leaves room to lengthen the token later without
// another migration; the lower bound is the floor that keeps guessing hopeless.
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;

// Bytes of entropy per minted token. 16 bytes -> 2^128 possible links: at a
// million guesses a second, finding any one live run takes longer than the
// universe has existed. That is the whole anti-crawling story — rate limiting
// on top of it is defence in depth, not the defence.
export const SHARE_TOKEN_BYTES = 16;

export function isValidShareToken(value) {
  return typeof value === "string" && SHARE_TOKEN_RE.test(value);
}

// Encode random bytes as base64url. Shared so the client's minting and any
// server-side minting can never produce different alphabets — a token that
// round-trips through a URL path segment must contain no +, / or =.
export function toBase64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
