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

**This provider is a scaffold. It is dormant, and not only for want of a client
id.** Read the next section before touching any request shape.

## What is documented, and what is not

COROS does not publish technical API documentation. The only public,
first-party source is the help-centre article
[Submit an API Application](https://support.coros.com/hc/en-us/articles/17085887816340-Submit-an-API-Application)
(the HTML page 403s to most fetchers; the same body is readable through the
public Help Center API at
`https://support.coros.com/api/v2/help_center/en-us/articles/17085887816340.json`).

**Documented fact**, from that article and nothing else:

- COROS grants third-party access "through our standard **OAuth 2.0** API
  framework" to any platform meeting its security and operational requirements.
- Onboarding is: submit company details, technical contacts and **OAuth 2.0
  redirect URIs**; accept the API Terms of Use (security, data-privacy
  compliance and **system rate limits**); then COROS issues an **API Client ID
  and Secret**.
- Applications go to `api@coros.com` plus the form linked from that article.

**Not documented anywhere public**: the authorization endpoint, the token
endpoint and its client-auth style, scopes, the API host, the workout listing
and its paging/`since` semantics, the activity-file download path, the file
format, the sport vocabulary, the rate-limit numbers, whether webhooks exist,
and every field name. Those arrive with the credentials.

So **every one of those is a `TODO(coros-api)` placeholder in this codebase,
deliberately left empty rather than filled from memory or inference.** An empty
URL can only fail loudly; a plausible-but-wrong one ships a sync that reports
"no new runs" forever.

**Do not substitute the unofficial API.** The publicly reverse-engineered
"COROS Training Hub API" (`teamapi.coros.com`, MD5-hashed password login, used
by various community libraries) is a different, non-OAuth interface that its own
authors describe as undocumented and liable to change without notice. It is not
the partner API this integration targets, and password-based vendor scraping is
already ruled out for this app on ToS grounds (see the Zepp note in
`docs/health-integrations.md`).

### Why the discipline, concretely

Suunto shipped against endpoints inferred from a sibling endpoint and needed two
follow-up PRs — #202 (sync reported "no new runs" on a working sync) and #203
(imports arrived with no route, because the FIT export path was extrapolated
from the listing path and answered 401) — **with** real credentials and a live
account to test against. A wrong endpoint never surfaces as an endpoint error:
it looks like nothing new happened, or like a run that just has no map. Guessing
with no API access at all would be strictly worse, so this PR does not.

## How it's wired

What is **real and tested** today:

- **Provider registration** — `corosProvider` in `src/imports/registry.ts`, its
  `cloudAuthCompleters` entry, and its `commitCloudScans` /
  `cloudBackfillPending` participation (it uses the same deferred ack as
  Suunto). `src/cloudOauthPreinit.ts` reserves the `coros_import` state
  prefixes, storage keys and the `solutions.camboulive.run://coros-callback`
  deep link (with the matching AndroidManifest intent filter); `polar.test.ts`
  already asserts every provider's prefixes and keys stay disjoint.
- **`corosWorkoutToRun`** — pure, unit-tested (`coros.test.ts`), and correct
  today, because it consumes **our** normalised shape rather than COROS's:
  file-first (route + HR series through the app's `parseFitFile`), summary
  fallback, watch-local calendar date from `utcOffsetMin`, whole-bpm heart rate,
  `extId: "coros:<key>"`. Never parse an activity file server-side.
- **The scan loop** — cursor + **deferred ack**, the protocol Suunto proved and
  the part that is ours, not COROS's: `sync` never advances the cursor, the
  client acks only after runs are saved, staged workouts ack by key and never
  move the watermark, and a page that produces no candidates acks immediately so
  quiet history still advances. Plus the **schema tripwire**: a page whose every
  fetched workout maps to null is treated as a normalisation mismatch and stops
  the scan WITHOUT acking, so a wrong field name becomes a log line instead of a
  silently consumed backfill. That guard matters more here than it did for
  Suunto, because nobody has ever seen a COROS payload.
- **`coros-import` actions that touch only our tables** — `status`,
  `disconnect` and `ack` are complete: they read and write
  `integration_connections` / `integration_staged_workouts` and call the atomic
  `ack_integration_cursor` RPC.
- **Dormancy**, asserted by a test: `coros.test.ts` pins that **no client id
  reaches the OAuth seam** while the request shapes are placeholders.

What is a **placeholder awaiting the API pack** (all marked `TODO(coros-api)`):

| Unknown | Where |
| --- | --- |
| Authorization URL, scope | `AUTH_URL` / `SCOPE`, `providers/coros.ts` |
| Token URL + client-auth style (Basic vs form body) | `TOKEN_URL` / `CLIENT_AUTH_IN_BODY` |
| API host, listing path, `since`/paging semantics | `API` / `LIST_PATH` |
| Activity-file path and format (FIT assumed) | `FILE_PATH` |
| Extra app/subscription key, rate limits | `apiFetch` headers, `COROS_FILE_DAILY_LIMIT` |
| Sport vocabulary (which values are run/walk) | `normalizeWorkout` |
| Every workout field name | `normalizeWorkout` |
| Provider-side account id in the token response | `externalUserIdFrom` |
| Whether webhooks exist at all | no `coros-webhook` function yet |

**The unknowns are deliberately concentrated in one server-side function.**
`normalizeWorkout(raw)` in `coros-import` is the only place that will ever know
COROS's vocabulary; it returns our `NormalWorkout` shape, so when the API pack
lands that one function learns the field names and the client's already-tested
mapper needs no change. (Suunto reads vendor field names client-side because its
summaries arrive from two differently-shaped sources — the listing and a webhook
body. COROS has no such constraint yet, so normalising at the edge is strictly
better here.)

### The two gates

`API_DOCUMENTED` is `false` in **both** `providers/coros.ts` and
`coros-import/index.ts`, and they must be flipped together.

- Client: the client id is passed to `makeCloudOauth` **only** when
  `API_DOCUMENTED` is true, so `isAvailable()` is false, the Settings row never
  renders, `scan()` returns nothing, and `connect()` can never parse the empty
  authorization URL. Setting `VITE_COROS_CLIENT_ID` alone **cannot** arm it.
- Server: without `COROS_CLIENT_ID`/`COROS_CLIENT_SECRET` every action answers
  `{skipped: "coros not configured"}`; with them but without `API_DOCUMENTED`,
  everything that would reach COROS answers
  `{skipped: "coros api not documented"}`.

A production build with no `VITE_COROS_CLIENT_ID` inlines
`{provider:"coros", authUrl:"", clientId:void 0, scope:""}`. The label strings
ship in the locale chunks, as Suunto's did before it was activated, but nothing
renders them: `ConnectionsCard` only builds a row for a cloud provider whose
`isAvailable()` resolves true.

## Activation (maintainer)

1. **Apply for API access.** Email `api@coros.com` and complete the form linked
   from the help-centre article above, with company details, technical contacts
   and the OAuth redirect URI `https://run.camboulive.solutions/` (trailing
   slash — it must equal `redirectUri()` in `src/imports/cloudOauth.ts`
   byte-for-byte). Accept the API Terms of Use. This is the schedule-critical
   step, and until it completes there is nothing to calibrate against.
2. **Fill in the API pack.** Replace every `TODO(coros-api)` constant in
   `providers/coros.ts` and `coros-import/index.ts`, write `normalizeWorkout`,
   then flip `API_DOCUMENTED` in both files. Update the dormancy test in
   `coros.test.ts` to assert the real authorization URL and scope. Confirm from
   the docs, rather than assuming: whether the token endpoint wants HTTP Basic
   or form-body client auth; whether PKCE S256 is supported (this provider opts
   in, like Suunto); whether an extra app key rides every API call; what unit
   and clock the listing's `since` uses; and what the export format actually is
   (if it is GPX or TCX rather than FIT, route the mapper's file branch through
   `parseActivityFile`).
3. **Server secrets**: `supabase secrets set COROS_CLIENT_ID=… COROS_CLIENT_SECRET=…`
   (plus any app/subscription key the pack requires).
4. **Client env — repo VARIABLE, not a secret** (the client id is public):
   Actions repo variable `VITE_COROS_CLIENT_ID`, already wired into
   `deploy.yml` / `deploy-pr.yml` / `release.yml` / `android-pr.yml`.
5. **No migration to apply** — `integration_connections` already serves this
   provider. Functions auto-deploy on merge to `main`, so set the secrets first.

## Verification

Local (no credentials): `supabase functions serve` + curl — every action
returns `{skipped}`; with fake secrets set, `status`/`ack`/`disconnect` still
work against the DB while `sync`/`file`/`exchange` return
`{skipped: "coros api not documented"}`, and `sync_cursor` only ever grows
(two concurrent acks never rewind it).

Live (after credentials, and **before** trusting the import): connect on web and
Android (deep-link bounce, cold start); watch the first backfill page in the
function logs — `coros-import sync since=… listed=… offered=…` is the line that
tells a wrong `since` unit from an over-strict sport filter, and
`coros-import skipped unrecognised workouts N` catches a sport vocabulary that
is still wrong. Then confirm a real run imports **with a map and an HR chart**,
not just with a distance: a route-less import is what a wrong file endpoint
looks like from the app, and it is the failure that took Suunto two follow-up
PRs to spot. Deliberately ignore an import toast and check the batch re-serves
on the next scan with no re-downloads; disconnect wipes both tables; reconnect
re-backfills.
