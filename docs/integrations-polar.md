# Polar (AccessLink) cloud import

The first real vendor-cloud import provider, for runners who leave the phone at
home and record on a **Polar** watch. It pulls each finished exercise's full
detail (GPS route, pace, elevation, heart-rate series) from Polar's cloud and
imports it as a run — the same review/dedupe/auto-tick pipeline every other
import uses.

Polar was chosen as the pilot because AccessLink is the only major vendor API
that is **free and fully self-serve** (no partner-approval wait), returns
GPX/TCX/FIT with route + HR samples, and has **no AI/ML data-use clause** — the
clause that rules out Strava (whose terms ban AI use of API data, and the coach
reads runs). Suunto and COROS are the intended next providers; the seam here is
reusable for them.

## How it's wired

Same shape as every import: a client `ImportProvider` (`src/imports/providers/
polar.ts`) registered in `src/imports/registry.ts`, plus a Supabase edge function
(`supabase/functions/polar-import`) that holds the OAuth **secret** and the
user's token — neither ever reaches the SPA bundle, mirroring `coach-agent`.

- **`integration_connections` table** (`supabase/migrations/
  20260730133032_integration_connections.sql`) stores the token as the
  `provider = 'polar'` row: `{ user_id, provider, external_user_id (the
  AccessLink user id), access_token }` (`refresh_token`/`expires_at` stay null —
  Polar tokens don't expire). One generic table serves every cloud provider
  (Suunto, COROS…). It is **service-role only**: RLS on, zero `authenticated`
  grants, so a client can never read the token — only the edge function
  (service_role) touches it. The original `polar_tokens` table
  (`20260721120000_polar_tokens.sql`) was copied into it by that migration; the
  function dual-reads (legacy fallback) until `polar_tokens` is dropped in a
  cleanup migration after live verification.
- **`polar-import` edge function** actions: `status`, `exchange` (code → token,
  register the user with AccessLink, store), `sync` (transaction pull → return
  each exercise's summary + GPX **text**), `disconnect`. It never parses GPX —
  it returns the raw GPX so the **client** parses it with the app's existing,
  tested `parseActivityFile`, so a Polar run gets the same map/pace/HR-series/
  time-in-zone detail a user-picked `.gpx` does.
- **Client provider**: `connect()` is a full-page OAuth redirect. The return is
  handled in two steps to avoid a collision with Supabase's own PKCE `?code=`
  handling (`detectSessionInUrl: true`): `src/cloudOauthPreinit.ts` — imported ahead
  of `./App` in `main.tsx` — runs first, detects the Polar return by its `state`
  marker, stashes the code in `sessionStorage` and strips the URL **before** the
  Supabase client can consume it; then `completePolarAuth()` (`RunningCoach`
  boot) reads the stashed code and exchanges it. `scan()` calls the `sync` action
  and maps exercises to runs (`polarExerciseToRun`, pure + unit-tested); runs are
  stamped `extId: "polar:<id>"` so the registry dedupes them like any other
  source.
- **Web + native.** On the shells, `connect()` opens the authorization page in
  the system browser (Android: plain top-frame navigation → `Bridge.launchIntent`
  hands it to the OS; iOS: `Browser.open` / SFSafariViewController) and marks the
  OAuth `state` with a `:native:` segment. Polar can only redirect to the ONE
  registered https redirect URL (the web origin), so the return lands on the web
  app in that browser — whose `cloudOauthPreinit` detects the native marker and
  **bounces** code+state to the `solutions.camboulive.run://polar-callback` deep
  link (scripted redirect attempted, plus an always-rendered "Open the app" tap
  target because browsers block scripted custom-scheme navigation without a
  gesture). `App.tsx` routes that deep link BEFORE its Supabase auth-code
  exchange (the native twin of the preinit's web-side guard), stashes code+state
  in localStorage (survives the OS killing the app under the browser; the nonce
  is stored in localStorage on native for the same reason) and fires
  `rc-cloud-oauth-return`; `RunningCoach` answers with the same `completePolarAuth()`
  exchange, which passes the SAME https redirect_uri (`WEB_APP_ORIGIN`) the
  authorization used. No Polar-side changes needed — one registered redirect URL
  serves both platforms. Native builds need `VITE_POLAR_CLIENT_ID` at web-bundle
  build time (wired in `release.yml` and `android-pr.yml`).

## Activation (maintainer)

Dormant until configured — exactly like `garminCloudProvider` and telemetry.
Without the pieces below, `isAvailable()` is `false`, nothing renders, and the
edge function returns `{ skipped }`. To turn it on:

1. **Register a Polar app** at <https://admin.polaraccesslink.com> (free; any
   Polar Flow account). Note the **client id** and **client secret**.
2. **Set the redirect/OAuth URL** in the Polar app to the production web origin
   **with a trailing slash**: `https://run.camboulive.solutions/`. It must match
   `redirectUri()` in `providers/polar.ts` exactly (= `window.location.origin`
   + `/`).
3. **Server secrets** (Supabase dashboard → Edge Functions → Secrets, or CLI):
   `supabase secrets set POLAR_CLIENT_ID=… POLAR_CLIENT_SECRET=…`
   then deploy: `supabase functions deploy polar-import` (or the MCP recipe /
   the merge-to-main auto-deploy in `deploy-supabase-functions.yml`).
4. **Client env — repo VARIABLE, not a secret** (the client id is public): set
   Actions repo variable `VITE_POLAR_CLIENT_ID` (Settings → Secrets and variables
   → Actions → Variables). It's wired into the web build in `deploy.yml` /
   `deploy-pr.yml`; the next production deploy inlines it and flips the provider
   visible.
5. **Apply the migration** (`supabase db push` — always BEFORE merging the
   function, which auto-deploys on merge) so `integration_connections` exists.

Once live, users see a **Polar** row in Settings → Integrations → Connect,
authorize on Polar, land back in the app connected, and their runs sync.

## Verification note

The AccessLink calls follow Polar's documented v3 API but **cannot be exercised
in CI or the dev sandbox** (no credentials; the proxy blocks polar.com). Verify
end-to-end after step 4 with a real Polar account: connect, record/sync a run on
the watch, then confirm it imports with a map + HR chart.

The Supabase `?code=` collision is already handled in code (`src/cloudOauthPreinit.ts`
strips the Polar return before the Supabase client sees it), so the remaining
first-run snags to check are Polar-API shapes, which the sandbox can't reach:

1. Token-endpoint field names (`x_user_id`) and the exercise-transaction
   lifecycle (create → list → GET each → commit) against Polar's current docs.
2. The `detailed-sport-info` / `sport` string values (the run/walk filter in
   `polarExerciseToRun`) — extend the sets if a run comes back skipped.

Everything downstream reuses the app's already-tested parsers.
