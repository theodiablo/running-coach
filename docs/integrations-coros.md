# COROS cloud import

Third vendor-cloud import provider, on the seam Polar established
(`docs/integrations-polar.md`) and Suunto generalised
(`docs/integrations-suunto.md`): a client `ImportProvider`
(`src/imports/providers/coros.ts`) + an edge function holding every secret
(`supabase/functions/coros-import`) + service-role-only rows in the generic
`integration_connections` table. **No migration was needed** — that table,
`integration_staged_workouts`, `ack_integration_cursor` and
`increment_integration_sync_usage` are all keyed by a free-text `provider`
column with no CHECK constraint, which is exactly what they were built for.

Calibrated against the **COROS API Reference V2.0.6 (February 2026)**, the
partner document issued with API credentials. Every endpoint and field in the
code cites a section of it. It is **not yet verified against a live account** —
there are still no credentials — so the provider stays dormant behind
`VITE_COROS_CLIENT_ID` exactly like Polar and Suunto, and the first live pass
should be read against the Verification section below.

The public help-centre article
[Submit an API Application](https://support.coros.com/hc/en-us/articles/17085887816340-Submit-an-API-Application)
remains the only *public* source (OAuth 2.0, apply via `api@coros.com`, Client
ID and Secret on approval). The reference itself is not published; do not try to
re-derive it from the unofficial `teamapi.coros.com` Training Hub API, which is
a different, non-OAuth interface.

## What COROS does differently

Three traits shape the whole integration, and none of them match Suunto.

**1. The workout list is a date range, not a cursor (§4.2).**
`GET /v2/coros/sport/list` takes `startDate`/`endDate` as `YYYYMMDD`, spans at
most **30 days** per call, and refuses any start earlier than **three months
before today** (revision V2.5, in force since 2024-01-01).

*There is therefore no full-history backfill, and there cannot be one.* The
reachable past is a rolling ~3-month window. We keep our own epoch-ms watermark
in `sync_cursor` and walk it forward 30 days at a time, clamped to a floor of
`now - 88 days` (the shortest calendar three-month span is 90 days, so 88 stays
inside it whatever the month and whichever clock COROS resolves "today" in). A
first connect starts at that floor, not at zero. **The user-facing copy says so**
— promising a full history import would be a lie the API cannot honour.

**2. The listing carries no heart rate and no elevation (§4.2.4).**
It has distance, duration, start/end time, timezone, sport, cadence, calories,
steps, device name, and a direct `fitUrl`. HR and elevation exist only inside
the `.fit`. So a COROS workout whose file is missing imports as distance and
duration only — no HR, no route. That is correct behaviour, not a degraded
import to be worked around, and it is why the mapper reads no HR from the
summary.

**3. Refresh does not rotate the token (§3.3).**
`POST /oauth2/refresh-token` answers `{"result":"0000","message":"OK"}` and
nothing else: it **extends the existing accessToken by 30 days**. Expecting a
new token here would throw on every refresh. The access token lasts 30 days; the
refresh token never expires. There is no rotation to race, so `getFreshToken`
needs no compare-and-swap — only the stored expiry moves.

Smaller but load-bearing details:

- **`state` must be `a-z A-Z 0-9`, max 128 bytes (§3.1.3).** COROS is the only
  provider on this seam whose state carries no `:` — `stateSep: ""` in
  `cloudOauthPreinit` and an alphanumeric nonce in `cloudOauth`. COROS itself
  recommends the state as the CSRF guard.
- **No `scope` parameter exists (§3.1.3)** — the authorization request documents
  only `client_id`, `redirect_uri`, `state`, `response_type`. An empty scope in
  the spec makes `buildAuthUrl` omit it; Polar's and Suunto's live URLs are
  unchanged.
- **No PKCE.** The token endpoint accepts no `code_verifier` (§3.2.3), so
  sending a challenge would be theatre. `pkce: false`.
- **Client credentials go in the form body (§3.2.2)**, not HTTP Basic.
- **Data calls take `?token=` and `?openId=` as query parameters** (§4.1-4.3),
  not an `Authorization` header.
- **Responses are HTTP 200 with a result code in the body**; `"0000"` is success.
  A non-0000 result is a failure however healthy the status line. **429** is the
  documented rate-limit signal (Addendum), and the cap is **1000 calls/minute**.
- **`openId`** (§3.2.4) is the COROS user id, stored as `external_user_id`.
- **Run sports** are the mode/subMode pairs `8/1` Outdoor Run, `8/2` Indoor Run,
  `15/1` Trail Run, `20/1` Track Run; **walk** is `31/1` Walk and `16/1` Hike
  (§4.2.4 workout type table).
- **`fitUrl` is handed to us, not constructed** — it points at COROS object
  storage and needs no token. The client passes it back on the `file` call, so
  the edge function treats it as untrusted input and fetches it only when it is
  `https` on a `coros.com` host. Without that check the action would be an open
  proxy into our network.
- **Sandbox exists**: `opentest.coros.com`. Set `COROS_API_BASE` to it while
  verifying with test credentials.
- **A workout summary push (webhook) is available** (§5): COROS POSTs new
  workouts every ~5 minutes with `client` and `secret` in the request *headers*,
  retries twice, and gives up after 24 hours. Not implemented yet — the staging
  table and the staged-workout path are already wired, so `coros-webhook` is
  additive whenever it is wanted.

## How it's wired

- **Provider registration** — `corosProvider` in `src/imports/registry.ts`, its
  `cloudAuthCompleters` entry, and its `commitCloudScans` /
  `cloudBackfillPending` participation. `src/cloudOauthPreinit.ts` holds the
  `corosimport` state prefixes, storage keys and the
  `solutions.camboulive.run://coros-callback` deep link (with the matching
  AndroidManifest intent filter); `polar.test.ts` asserts every provider's
  prefixes and keys stay disjoint.
- **`corosWorkoutToRun`** — pure and unit-tested (`coros.test.ts`). File first
  (route + HR series through the app's `parseFitFile`), summary fallback,
  watch-local calendar date from the 15-minute timezone unit, `extId:
  "coros:<labelId>"`. Never parse a `.fit` server-side.
- **The scan loop** — cursor + **deferred ack**: `sync` never advances the
  cursor, the client acks only after runs are saved, staged workouts ack by key
  and never move the watermark, and a page with no candidates acks immediately
  so quiet windows still advance. A workout COROS listed with no `fitUrl` skips
  the download call entirely rather than spending a request to be told there is
  no file.
- **The schema tripwire** — a page whose every fetched workout maps to null
  stops the scan *without* acking. It guards `normalizeWorkout`, which is the
  one function that could still be wrong in a way nothing else would catch: a
  changed field name would otherwise consume the window silently.
- **`normalizeWorkout` is the only place that knows COROS's vocabulary** —
  mode/subMode pairs, epoch seconds, 15-minute timezone units — so the browser
  never sees any of it. The same shape arrives from the listing and from the
  summary push (§5.3.3), so one function serves both when the webhook lands.

### Dormancy

One gate, the same as every other cloud provider: `isAvailable()` is false
without `VITE_COROS_CLIENT_ID`, and the edge function answers
`{skipped: "coros not configured"}` without `COROS_CLIENT_ID` /
`COROS_CLIENT_SECRET`. (The earlier scaffold carried a second `API_DOCUMENTED`
gate because the request shapes were placeholders. They are documented now, so
that gate is gone.)

`ConnectionsCard` only builds a row for a cloud provider whose `isAvailable()`
resolves true, so a build without the variable renders nothing.

## Activation (maintainer)

1. **Apply for API access.** Email `api@coros.com` and complete the form linked
   from the help-centre article, with company details, technical contacts and
   the OAuth redirect URI `https://run.camboulive.solutions/` (trailing slash —
   it must equal `redirectUri()` in `src/imports/cloudOauth.ts` byte-for-byte).
   §1.2 also asks for an application name (≤50 chars), a description (≤100
   chars) and a logo as PNG in **two** sizes, 144x144 and 102x102. COROS accepts
   one or two callback domains.
2. **Server secrets**: `supabase secrets set COROS_CLIENT_ID=… COROS_CLIENT_SECRET=…`
   Optionally `COROS_API_BASE=https://opentest.coros.com` to run against the
   sandbox first, and `COROS_FILE_DAILY_LIMIT` to change the per-user daily
   download cap from its default of 300.
3. **Client env — repo VARIABLE, not a secret** (the client id is public):
   Actions repo variable `VITE_COROS_CLIENT_ID`, already wired into
   `deploy.yml` / `deploy-pr.yml` / `release.yml` / `android-pr.yml`.
4. **No migration to apply** — `integration_connections` already serves this
   provider. Functions auto-deploy on merge to `main`, so set the secrets first.

## Verification

Local (no credentials): `supabase functions serve` + curl — every action
returns `{skipped}`. With fake secrets set, `status` / `ack` / `disconnect`
still work against the DB, and `sync_cursor` only ever grows (two concurrent
acks never rewind it).

Live, against the sandbox first if credentials allow. The code is documented but
unproven, so read the function logs before trusting an import:

- `coros-import sync 20260601..20260701 listed=… offered=…` is the line that
  separates an empty window from an over-strict sport filter. If `listed` is 0
  for a range you know has runs, suspect the **date resolution** — COROS does
  not say which clock it reads `YYYYMMDD` in, and ours is UTC.
- `coros-import skipped non-run workouts N` catches a mode/subMode pair we do
  not recognise yet.
- Confirm a run imports **with a map and an HR chart**, not merely with a
  distance. For COROS a missing `.fit` means no route *and* no heart rate, which
  on screen looks like an ordinary manual entry rather than an error. This is
  the failure that took Suunto two follow-up PRs to spot.
- **Check the three-month floor behaves**: a first connect should import roughly
  the last three months and then stop, and `hasMore` should go false rather than
  looping. A window with no workouts must still advance the cursor.
- **Check the refresh path** by forcing `expires_at` into the past: the sync
  should still work and the row's expiry should move forward *without* the
  access token changing (§3.3 extends rather than rotates).
- Unbind the app inside the COROS app and reopen Settings: the row should flip
  to disconnected via the `bindState` check (§3.5).
- Deliberately ignore an import toast and check the batch re-serves on the next
  scan with no re-downloads; disconnect wipes both tables and deauthorizes at
  COROS; reconnect re-imports the reachable window.
