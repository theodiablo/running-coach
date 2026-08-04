// CORS + JSON response helpers shared by every edge function, so a header
// change is a one-file edit instead of one per function.
//
// `Access-Control-Allow-Origin: *` on purpose: each function's real gate is its
// JWT (or, for live-watch, the share token), which curl presents with no CORS
// at all — locking the origin would protect nothing.
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// `extra` is for per-function response headers (e.g. live-watch's no-store).
export const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", ...extra },
  });
