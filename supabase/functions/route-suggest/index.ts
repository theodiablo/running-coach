// route-suggest — server side of the "Find a route" loop suggestion feature.
// The ORS API key is quota-bearing and can't be domain-restricted, so it must
// never ship client-side (same rule as coach-agent/polar-import secrets). This
// proxy verifies the JWT, enforces the daily budget and premium gate
// (profiles.premium_until, service-role-writable only — src/premium.ts is a UI
// hint only), fans out seeded ORS requests, and returns raw GeoJSON; all
// parsing/scoring stays in tested client code (src/utils/routeSuggest.ts).
// The ORS call is isolated in fetchLoopGeoJSON below so swapping backends
// later (GraphHopper/BRouter) never changes the client-facing contract.
// Request/response shape and deploy/secrets: docs/route-finder.md.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ORS_API_KEY = Deno.env.get("ORS_API_KEY");
const ORS_BASE = Deno.env.get("ORS_BASE_URL") ?? "https://api.openrouteservice.org";
const LIMIT_PER_DAY = Number(Deno.env.get("ROUTE_SUGGEST_LIMIT_PER_DAY") ?? 30);
const MAX_CANDIDATES = 5; // hard cap on ORS calls per generation (quota guard)
// ORS round-trip returns a street-following loop that is systematically LONGER
// than the requested `length` (typically +20-40%). Rather than guess one
// correction factor (it varies by area), we request a SPREAD of target lengths
// centred BELOW 1.0 to counter the overshoot, so that across the usual overshoot
// range at least ~3 of the returned loops land near the asked distance and the
// client can reliably show three. (Centre ~0.85; the spread brackets it.)
const LENGTH_FACTORS = [0.65, 0.75, 0.85, 0.95, 1.05];

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

type SeedResult = { feature: unknown | null; err?: string };

// A feature is USABLE only if it carries a drawable line (≥2 coordinates). ORS
// can answer 200 with a feature whose geometry is empty/degenerate; charging for
// that would bill the user for a loop the client then rejects, so we filter to
// usable features BEFORE charging and refund when none survive.
function isUsableFeature(feature: unknown): boolean {
  const geometry = feature && typeof feature === "object" ? (feature as { geometry?: unknown }).geometry : null;
  const coords = geometry && typeof geometry === "object" ? (geometry as { coordinates?: unknown }).coordinates : null;
  return Array.isArray(coords) && coords.length >= 2;
}

// Is this account premium right now? Reads profiles.premium_until through the
// admin (service-role) client, mirroring coach-agent's getDailyLimit — the
// column is service-role-writable only, so the value can't be self-granted.
//
// THROWS on a read failure rather than returning false: a transient DB error
// must land on the generic error path, never tell a paying user they aren't
// premium. NaN (including the string "infinity", which the migration bans) is
// treated as not-premium, matching isPremiumActive on the client exactly.
// deno-lint-ignore no-explicit-any
async function isPremiumUser(admin: any, userId: string): Promise<boolean> {
  const { data, error } = await admin.from("profiles")
    .select("premium_until").eq("id", userId).maybeSingle();
  // 42703 = undefined_column: the premium migration hasn't been applied yet
  // (functions auto-deploy on push to main; migrations are applied by hand).
  // Nobody can be premium in that state, so answer PREMIUM_REQUIRED rather than
  // erroring — the gated feature stays shut, which is the safe direction.
  if (error?.code === "42703") {
    console.error("route-suggest: profiles.premium_until missing — apply the premium migration");
    return false;
  }
  if (error) throw error;
  const t = data?.premium_until ? Date.parse(String(data.premium_until)) : NaN;
  return Number.isFinite(t) && t > Date.now();
}

// ── Backend seam ────────────────────────────────────────────────────────────
// One round-trip request → one GeoJSON Feature (or an error string, so one bad
// seed never sinks the whole generation but we can still see WHY it failed).
async function fetchLoopGeoJSON(
  profile: string, lat: number, lng: number, lengthM: number, seed: number,
): Promise<SeedResult> {
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
        // NB: the ORS foot profiles reject extra_info:["waytypes"] (error 2003 —
        // that's a driving/cycling extra); `surface` IS valid and the client
        // derives the route "character" (paths vs streets) from it.
        extra_info: ["surface"],
        // options.round_trip drops pseudo-via-points on a circle of ~lengthM
        // circumference around the start; `seed` varies the direction so
        // different seeds yield genuinely different loops. green/quiet weightings
        // bias toward parks and away from busy roads (valid for foot profiles).
        options: {
          round_trip: { length: lengthM, points: 4, seed },
          profile_params: { weightings: { green: 1, quiet: 1 } },
        },
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      const err = `status=${res.status} ${errBody.slice(0, 300)}`;
      console.error(`route-suggest ORS fail: ${profile} seed=${seed} ${err}`);
      return { feature: null, err };
    }
    const body = await res.json().catch(() => null);
    const feature = body && Array.isArray(body.features) ? body.features[0] : null;
    return { feature: feature ?? null };
  } catch (e) {
    const err = `threw ${String(e).slice(0, 200)}`;
    console.error(`route-suggest ORS ${profile} seed=${seed} ${err}`);
    return { feature: null, err };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
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

    if (!ORS_API_KEY) { console.error("route-suggest: ORS_API_KEY not set"); return json({ configured: false }); }

    const payload = await req.json().catch(() => ({})) as Record<string, unknown>;
    const lat = Number(payload.lat), lng = Number(payload.lng), km = Number(payload.km);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(km) || km <= 0) {
      return json({ error: "lat, lng and a positive km are required" }, 400);
    }
    const count = Math.min(MAX_CANDIDATES, Math.max(1, Math.floor(Number(payload.count) || 3)));
    const seedBase = Math.max(0, Math.floor(Number(payload.seedBase) || 0));
    const profile = profileFor(payload.elevation);
    const lengthM = Math.round(km * 1000);

    // Service role — reads the premium seam and the usage counter, neither of
    // which the client can touch.
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Premium gate, deliberately BEFORE the charge below: a free caller must
    // never increment (or even create) a daily-quota row for a feature they
    // can't use — and it costs one profiles read instead of a charge+refund.
    if (!(await isPremiumUser(admin, user.id))) {
      return json({ error: "premium feature", code: "PREMIUM_REQUIRED" });
    }

    // Per-user daily budget.
    const today = new Date().toISOString().slice(0, 10);

    // Charge FIRST, atomically, then decide — so two concurrent generations can
    // never both read a stale count under the cap and each slip through. The
    // increment RPC is a single atomic upsert returning the new count. If that
    // count exceeds the cap, this request is the one over budget: refund the unit
    // and report RATE_LIMIT. (A refund can't drive the counter below 0.)
    const { data: chargedRaw, error: chargeErr } = await admin.rpc("increment_route_suggest_usage", {
      p_user_id: user.id, p_day: today,
    });
    if (chargeErr) throw chargeErr;
    let used = Number(chargedRaw);
    const refund = async () => {
      const { data: back } = await admin.rpc("decrement_route_suggest_usage", { p_user_id: user.id, p_day: today });
      if (back != null) used = Number(back);
    };
    if (used > LIMIT_PER_DAY) {
      await refund();
      return json({ error: "daily route limit reached - try again tomorrow", code: "RATE_LIMIT",
        usage: { used: LIMIT_PER_DAY, limit: LIMIT_PER_DAY } });
    }

    // Each seed also gets a different target length (the spread above) so the
    // returned loops bracket the requested distance regardless of the local
    // overshoot; the client keeps the closest.
    const reqs = Array.from({ length: count }, (_, i) => ({
      seed: seedBase + i,
      lengthM: Math.round(lengthM * LENGTH_FACTORS[i % LENGTH_FACTORS.length]),
    }));
    const results = await Promise.all(reqs.map(r => fetchLoopGeoJSON(profile, lat, lng, r.lengthM, r.seed)));
    // Only DRAWABLE loops count — an empty/degenerate ORS feature the client would
    // reject must not be billed (see isUsableFeature).
    const features = results.map(r => r.feature).filter(isUsableFeature);

    // Refund the charge when the generation produced no usable loop, so a barren
    // area (or an ORS hiccup) costs the user nothing from their daily budget.
    if (!features.length) await refund();
    return json({ configured: true, features, usage: { used, limit: LIMIT_PER_DAY } });
  } catch (err) {
    console.error("route-suggest error", err);
    return json({ error: String(err) }, 200);
  }
});
