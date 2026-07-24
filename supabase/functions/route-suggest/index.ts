// route-suggest — server side of the "Find a route" loop suggestion feature.
//
// Why server-side: the openrouteservice (ORS) API key is quota-bearing and,
// unlike the publishable MapTiler key, CANNOT be domain-restricted, so it must
// never ship in the SPA bundle (same rule as coach-agent's Anthropic key and
// polar-import's Polar secret). This thin proxy verifies the caller's JWT,
// enforces a per-user daily budget, reads ORS_API_KEY from function secrets,
// fans out a few seeded round-trip requests, and passes the raw GeoJSON back —
// ALL parsing/scoring stays in tested client code (src/utils/routeSuggest.ts),
// so the numbers the user sees come from the same geo utils the tracker records
// with. The client only ever talks to this function, so no routing host reaches
// the browser and the one index.html CSP (connect-src https://*.supabase.co)
// needs no change on any platform.
//
// Request (JSON body, caller JWT forwarded by functions.invoke):
//   { lat, lng, km, elevation?: "flat"|"rolling"|"hilly", seedBase?, count? }
// Response:
//   { configured: false }                        ORS_API_KEY unset — dormant
//   { error, code: "RATE_LIMIT", usage }         daily budget spent
//   { configured: true, features: GeoJSONFeature[] }   0..count loop candidates
//
// Deploy:  supabase functions deploy route-suggest
// Secrets: supabase secrets set ORS_API_KEY=...
//          Without it every call returns { configured:false } and the client
//          feature stays invisible (VITE_ROUTE_SUGGEST unset) — a safe no-op.
//
// Backend independence (Phase 4): the ORS call is isolated in fetchLoopGeoJSON
// below. Self-hosting GraphHopper OSS or BRouter later means repointing THAT
// one function — the request/response contract the client sees never changes.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ORS_API_KEY = Deno.env.get("ORS_API_KEY");
const ORS_BASE = Deno.env.get("ORS_BASE_URL") ?? "https://api.openrouteservice.org";
const LIMIT_PER_DAY = Number(Deno.env.get("ROUTE_SUGGEST_LIMIT_PER_DAY") ?? 30);
const MAX_CANDIDATES = 5; // hard cap on ORS calls per generation (quota guard)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Map the user's elevation preference to an ORS foot profile. foot-hiking
// prefers trails/tracks and tolerates more climb (the "hilly" intent);
// foot-walking is the flatter, street-and-path default.
function profileFor(elevation: unknown): string {
  return elevation === "hilly" ? "foot-hiking" : "foot-walking";
}

// ── Backend seam ────────────────────────────────────────────────────────────
// One round-trip request → one GeoJSON Feature (or null on any failure, so one
// bad seed never sinks the whole generation). Swapping ORS for a self-hosted
// GraphHopper/BRouter later is a change to THIS function only.
async function fetchLoopGeoJSON(
  profile: string, lat: number, lng: number, lengthM: number, seed: number,
): Promise<unknown | null> {
  try {
    const res = await fetch(`${ORS_BASE}/v2/directions/${profile}/geojson`, {
      method: "POST",
      headers: {
        "Authorization": ORS_API_KEY!,
        "Content-Type": "application/json",
        "Accept": "application/geo+json",
      },
      body: JSON.stringify({
        coordinates: [[lng, lat]],
        elevation: true,
        extra_info: ["waytypes"],
        // options.round_trip drops pseudo-via-points on a circle of ~lengthM
        // circumference around the start; `seed` varies the direction so
        // different seeds yield genuinely different loops. green/quiet weightings
        // bias toward parks and away from busy roads — the product intent.
        options: {
          round_trip: { length: lengthM, points: 4, seed },
          profile_params: { weightings: { green: 1, quiet: 1 } },
        },
      }),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const feature = body && Array.isArray(body.features) ? body.features[0] : null;
    return feature ?? null;
  } catch {
    return null; // network / parse error on one seed — skip it
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    // Resolve the caller from their JWT (forwarded by functions.invoke).
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "unauthorized" }, 401);
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: auth } = await userClient.auth.getUser();
    const user = auth?.user;
    if (!user) return json({ error: "unauthorized" }, 401);

    // Dormant until configured: no ORS key ⇒ the client treats this like "no
    // result" and never renders the feature (VITE_ROUTE_SUGGEST also unset).
    if (!ORS_API_KEY) return json({ configured: false });

    const payload = await req.json().catch(() => ({})) as Record<string, unknown>;
    const lat = Number(payload.lat), lng = Number(payload.lng), km = Number(payload.km);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(km) || km <= 0) {
      return json({ error: "lat, lng and a positive km are required" }, 400);
    }
    const count = Math.min(MAX_CANDIDATES, Math.max(1, Math.floor(Number(payload.count) || 3)));
    const seedBase = Math.max(0, Math.floor(Number(payload.seedBase) || 0));
    const profile = profileFor(payload.elevation);
    const lengthM = Math.round(km * 1000);

    // Per-user daily budget. Service role only — the client can't touch it.
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const today = new Date().toISOString().slice(0, 10);
    // Read the current count and reject if the cap is already spent — WITHOUT
    // charging yet. We only charge a generation that actually returns loops
    // (below), so an ORS outage or an area with no routable loops doesn't burn
    // the user's daily budget for a blank "couldn't fetch" toast. The check→charge
    // gap allows a small race under concurrency, an acceptable trade for not
    // billing failures on a low-stakes feature (unlike the coach's atomic path).
    const { data: usageRow, error: usageErr } = await admin.from("route_suggest_usage")
      .select("count").eq("user_id", user.id).eq("day", today).maybeSingle();
    if (usageErr) throw usageErr;
    const usedBefore = Number(usageRow?.count) || 0;
    if (usedBefore >= LIMIT_PER_DAY) {
      return json({ error: "daily route limit reached — try again tomorrow", code: "RATE_LIMIT",
        usage: { used: LIMIT_PER_DAY, limit: LIMIT_PER_DAY } });
    }

    // Fan out the seeded round-trip calls concurrently; drop the failures.
    const seeds = Array.from({ length: count }, (_, i) => seedBase + i);
    const results = await Promise.all(seeds.map(s => fetchLoopGeoJSON(profile, lat, lng, lengthM, s)));
    const features = results.filter(Boolean);
    // Charge ONE unit per successful generation, atomically (the increment guards
    // against a concurrent double-charge). A generation that produced nothing is
    // free — see the read-only pre-check above.
    let used = usedBefore;
    if (features.length) {
      const { data: charged, error: chargeErr } = await admin.rpc("increment_route_suggest_usage", {
        p_user_id: user.id, p_day: today,
      });
      if (chargeErr) throw chargeErr;
      used = Number(charged);
    }
    return json({ configured: true, features, usage: { used, limit: LIMIT_PER_DAY } });
  } catch (err) {
    console.error("route-suggest error", err);
    // Never hard-fail the caller: the client resolves null and shows a toast.
    return json({ error: String(err) }, 200);
  }
});
