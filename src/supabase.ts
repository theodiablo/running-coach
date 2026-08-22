import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";
import { isNative } from "./native";

// supabase-js issues every request (auth token exchange, token refresh,
// PostgREST queries) through the browser `fetch` with NO client-side timeout
// — see @supabase/auth-js `_handleRequest`, which simply `await`s the fetch.
// A single stalled connection therefore hangs forever, and because the auth
// client runs the PKCE code-exchange inside a one-shot `initialize()` promise
// that getSession(), onAuthStateChange() AND every authenticated PostgREST
// query all await, one hung request strands the whole app on the splash
// spinner after an OAuth redirect. Wrapping fetch in an AbortController-backed
// timeout bounds every request: a stall aborts and surfaces as a normal
// network error that the existing error paths already handle, instead of
// hanging indefinitely.
const REQUEST_TIMEOUT_MS = 15000;

// PostgREST answers 401 `PGRST303` ("JWT issued at future") when a token's
// `iat` is ahead of the clock on the node validating it. The skew is between
// Supabase's OWN auth and PostgREST nodes, not ours, so it can only ever
// reject a token that is a second or two old — the burst of requests fired
// immediately after a sign-in or a sign-up confirmation, and nothing later.
// Untreated it reads as a broken app rather than a hiccup: the `app_state`
// boot read 401s, `initStore` reports "failed", and App.tsx shows
// StoreLoadError until the user taps Retry. That is exactly what a real user
// got after opening the Android registration deep link — rejected at
// T+0.3s, accepted on the manual retry at T+9.4s — so the delays below cover
// ~10s in total, well past the observed skew.
//
// Retrying is safe even for a write: PostgREST decides this before the
// request reaches the database, so nothing has happened yet.
const SKEW_RETRY_DELAYS_MS = [500, 1500, 3000, 5000];

type TimeoutRequestInit = RequestInit & { timeoutMs?: number | null };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Read from a CLONE so the caller still gets an untouched body: a 401 that is
// not a PostgREST error (a wrong password from /auth/v1/token, say) must be
// returned as-is, and is never retried.
async function isFutureIatRejection(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  try {
    const body = await res.clone().json();
    return (body as { code?: unknown } | null)?.code === "PGRST303";
  } catch {
    return false;
  }
}

// Only a body we can hand to `fetch` again may be retried; a stream is consumed
// by the first attempt. supabase-js sends strings, so this is a guard, not a
// limitation in practice.
const isReplayable = (body: BodyInit | null | undefined) =>
  body == null || typeof body === "string";

// `timeoutMs` is intentionally a wrapper option, not part of the native fetch
// API. Pass `null` to opt out when another cancellation mechanism owns the
// request. If a caller supplies a native `signal` and no `timeoutMs`, we also
// opt out of the default timeout so the caller's signal is not accidentally
// shortened by this wrapper.
function sendOnce(
  input: RequestInfo | URL,
  fetchInit: RequestInit,
  upstreamSignal: AbortSignal | null | undefined,
  timeoutMs: number | null,
) {
  if (timeoutMs == null) return fetch(input, { ...fetchInit, signal: upstreamSignal });

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
    timeoutMs
  );
  let removeUpstreamAbort = () => {};
  if (upstreamSignal) {
    const abortFromUpstream = () => controller.abort(upstreamSignal.reason);
    if (upstreamSignal.aborted) abortFromUpstream();
    else {
      upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
      removeUpstreamAbort = () => upstreamSignal.removeEventListener("abort", abortFromUpstream);
    }
  }
  return fetch(input, { ...fetchInit, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    removeUpstreamAbort();
  });
}

// Exported for tests only; the client below is the single production caller.
export async function fetchWithTimeout(input: RequestInfo | URL, init: TimeoutRequestInit = {}) {
  const { timeoutMs: configuredTimeoutMs, signal: upstreamSignal, ...fetchInit } = init;
  const timeoutMs = configuredTimeoutMs ?? (upstreamSignal ? null : REQUEST_TIMEOUT_MS);
  const send = () => sendOnce(input, fetchInit, upstreamSignal, timeoutMs);

  let res = await send();
  if (!isReplayable(fetchInit.body)) return res;
  for (const delay of SKEW_RETRY_DELAYS_MS) {
    if (upstreamSignal?.aborted) return res;
    if (!(await isFutureIatRejection(res))) return res;
    await sleep(delay);
    res = await send();
  }
  return res;
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true },
  global: { fetch: fetchWithTimeout },
});

// Where Supabase sends the user back after an OAuth / magic-link sign-in. In the
// browser that's the app's own origin. Inside the Capacitor shell the origin is
// http://localhost (not reachable externally), so we return a registered deep
// link instead; App.jsx listens for it via @capacitor/app and completes the PKCE
// exchange. This scheme must be added to the Supabase Auth redirect allow-list.
export const AUTH_DEEP_LINK = "solutions.camboulive.run://auth-callback";
export const authRedirectTo = () =>
  isNative ? AUTH_DEEP_LINK : `${window.location.origin}/`;
