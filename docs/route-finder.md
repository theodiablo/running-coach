# Route finder — "Find me somewhere to run" (loop suggestions)

From the user's current location and a target distance, suggest 2-3 candidate
**loop** routes (start = finish), biased toward footpaths/parks/quiet streets,
draw them on the map, let the user pick one, and overlay the chosen line in the
live tracker. Loops from a point only — no point-to-point directions, no
multi-waypoint planning.

Dormant by default: the feature renders nothing unless BOTH the client flag and
the server key are configured (see **Configuration**).

## Backend + licensing

MVP backend is **openrouteservice** (ORS) — the only zero-infra option with a
real round-trip loop endpoint (`options.round_trip {length, points, seed}`) and
green/quiet foot weightings that match "prefer parks, avoid busy roads". Called
ONLY from the `route-suggest` edge function; the client never talks to ORS.

- OSM data is ODbL → "© OpenStreetMap contributors" must show wherever route
  geometry is displayed. The finder sheet shows an OSM + ORS attribution line;
  `RouteMap` already carries the basemap OSM credit.
- ORS free tier has no AI/model-training restriction (unlike Strava, which is
  excluded from imports for that reason). Best-effort, no SLA — fine at low
  volume; the migration path at scale is self-hosting, not a paid plan.
- **Backend independence (Phase 4):** the ORS call is isolated in
  `fetchLoopGeoJSON` in `supabase/functions/route-suggest/index.ts`. Self-hosting
  GraphHopper OSS (Apache-2.0, same round-trip algorithm family — ORS is a
  GraphHopper fork) or BRouter (MIT) later means repointing THAT one function;
  the request/response contract the client sees never changes, so the app is
  untouched. `ORS_BASE_URL` already lets you point at a self-hosted ORS.

Round-trip engines drop pseudo-via-points on a circle with randomness, so expect
±10-20% length error and occasional out-and-back stretches. The fix (and our
design): request several candidates with different `seed`s and **score them
client-side** (length error, self-overlap), presenting the best. "Regenerate" =
new seeds.

## Trust boundary + rate limiting

The ORS key is quota-bearing and cannot be domain-restricted, so it must not
ship in the bundle — same rule as the coach's Anthropic key. `route-suggest`
(Deno) verifies the caller's JWT, enforces a per-user daily budget, reads
`ORS_API_KEY` from function secrets, fans out the seeded round-trip calls, and
passes the raw GeoJSON back. All parsing/scoring stays in tested client code.

- **Usage table:** `route_suggest_usage` + atomic
  `increment_route_suggest_usage(uuid, date)` (service-role only), mirroring the
  coach's `agent_usage` limiter. `ROUTE_SUGGEST_LIMIT_PER_DAY` (default 30) is
  charged once per *generation* (not per seed). Append-only migration rules apply.
- **Zero CSP change:** the client only calls
  `https://<ref>.supabase.co/functions/v1/route-suggest`, already covered by
  `connect-src https://*.supabase.co`. If a future phase ever calls a routing
  host directly from the client, add that host to `connect-src` then.

## Client pieces

- `src/utils/routeSuggest.ts` — mirrors `geocode.ts`: config-guarded, plain
  `functions.invoke`, and **never throws** (resolves `null` when off / offline /
  rate-limited / no result). Pure, unit-tested helpers do all the work:
  - `parseLoopCandidates` — decode ORS GeoJSON `[lng,lat,ele]` → measured
    `SuggestedRoute`s. km/elevation come from the SAME geo utils the tracker
    records with (`distanceKm`/`elevGainM`), measured on the full line then
    `simplify()`d for storage — so a suggestion can't read differently from the
    logged run.
  - `selfOverlapPct` / `acceptable` / `rankCandidates` — Phase 2 scoring
    (reject >20% length error or heavy self-overlap; retry with fresh seeds up to
    a small cap; loose elevation-preference filter).
  - `overlapWithHistory` — Phase 3 "somewhere new"; coordinates never leave the
    device (recent `run_routes` fetched and compared client-side).
- `src/savedRoutes.ts` — Phase 4 favourites CRUD against the `saved_routes`
  table (direct queries, like `routes.ts`). **Separate from `run_routes`** so
  planned geometry never pollutes recorded traces.
- `SuggestedRoute` (`src/types.ts`) — `{id, points:[lat,lng,alt|null][], km,
  elevation, character?}`. NOT a recorded trace: no timestamps, never touches
  `run_routes`/`routeId`, ephemeral client memory only.

## UI + handoff

- **Entry point:** a "Find a route" button on the live tracker's **idle**
  screen (`LiveRunTracker`), reusing the tracker's existing `geoSource` location
  preview — no new geolocation code, and it inherits the native permission gate.
- **`RouteFinderSheet`** (`src/modals/`) — distance chips + free input, terrain
  toggle (flat/rolling/hilly → foot-walking vs foot-hiking + elevation filter),
  "somewhere new", "set start point" (tap the map), a `RouteMap` showing
  candidates, one card per candidate (distance, +elevation, character), star to
  save a favourite, regenerate, safety copy, and OSM/ORS attribution. Registers
  `useDismissable`.
- **`RouteMap` guide layer:** additive `guides` / `guidePoints` props draw
  non-recorded lines in a dedicated low-z `"guide"` pane so they sit UNDER the
  recorded track. Sky `#38bdf8` (dashed for the planned line; selected candidate
  solid sky, others muted slate) — visually distinct from the orange record
  line, so live-recorded vs planned can never be confused. The existing `points`
  contract is untouched; `fitGuides` frames the guides only while there's no
  recorded track.
- **Handoff:** picking a candidate sets `plannedRoute` in `LiveRunTracker`, drawn
  as `guidePoints`. Purely visual — `useRunTracker` is not modified; the runner
  follows the line by eye. Nothing of the suggestion persists on save.

## Safety copy

Shown in the sheet, small and always visible (not a dismissable warning), framed
as *suggestions from open map data*, neutral and factual — no liability legalese.
Bias hard toward well-mapped paths at the request level (green/quiet weightings,
`foot-walking`) so the copy rarely has to do the work. i18n under
`routeFinder.*` (en/es/fr; French informal `tu`; no em dashes).

## Configuration (dormant until both are set)

- **Client:** `routeSuggestEnabled = !!MAP_KEY && VITE_ROUTE_SUGGEST !== "0"`
  (`src/constants.ts`) — the button renders wherever a MapTiler key exists;
  set the repo **variable** `VITE_ROUTE_SUGGEST="0"` to force it hidden for a
  deployment. (It's still threaded through the web-build workflows so that
  opt-out reaches the bundle.) The server gate below is the real safety net, so
  a visible button with no `ORS_API_KEY` just degrades to the "couldn't fetch"
  toast rather than exposing anything.
- **Server:** set the `ORS_API_KEY` function secret (optionally `ORS_BASE_URL`,
  `ROUTE_SUGGEST_LIMIT_PER_DAY`). Without it, `route-suggest` returns
  `{configured:false}` and the client treats it as "no result". Deploys via the
  existing changed-function detection in `deploy-supabase-functions.yml`.

## Telemetry

One consent-gated count event, `route_suggested` (no properties), fired when a
generation starts. See `docs/telemetry.md`.
