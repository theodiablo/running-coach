import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";
import { isNative } from "./native";

// supabase-js requests have NO client-side timeout (auth-js `_handleRequest` just awaits fetch), and one
// stalled request in the one-shot PKCE `initialize()` strands the app on the splash spinner. Wrapping fetch
// in an AbortController timeout turns a stall into a normal network error the existing paths handle.
const REQUEST_TIMEOUT_MS = 15000;

// PostgREST answers 401 `PGRST303` ("JWT issued at future") when Supabase's own auth and PostgREST nodes
// disagree on the clock, so only requests right after a sign-in/sign-up confirmation are hit; untreated it
// dead-ends on StoreLoadError. The delays below cover ~10s, past the observed skew. Retrying is safe even
// for writes: PostgREST rejects this before the request reaches the database.
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

// `timeoutMs` is a wrapper option, not native fetch. `null` opts out when another mechanism owns
// cancellation; a caller-supplied `signal` with no `timeoutMs` also opts out, so the default timeout
// never shortens the caller's signal.
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

// The bundle id, which doubles as the custom URL scheme below and as the client
// id the native Sign in with Apple sheet reports (src/auth/appleSignIn.ts).
export const NATIVE_BUNDLE_ID = "solutions.camboulive.run";

// Where Supabase sends the user back after OAuth / magic-link sign-in: the app origin on web, a registered
// deep link in the Capacitor shell (its origin, http://localhost, isn't externally reachable); App listens
// via @capacitor/app and completes the PKCE exchange. The scheme must be on the Supabase redirect allow-list.
export const AUTH_DEEP_LINK = `${NATIVE_BUNDLE_ID}://auth-callback`;
export const authRedirectTo = () =>
  isNative ? AUTH_DEEP_LINK : `${window.location.origin}/`;
