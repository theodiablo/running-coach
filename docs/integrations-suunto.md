# Suunto cloud import

Second vendor-cloud import provider, on the seam Polar established
(`docs/integrations-polar.md`): a client `ImportProvider`
(`src/imports/providers/suunto.ts`) + edge functions holding every secret +
service-role-only rows in the generic `integration_connections` table. What's
new versus Polar: Suunto issues **short-lived tokens** (refresh flow), serves
**FIT files** (parsed client-side by the existing `parseFitFile`), has **no
server-side transaction** (so the sync cursor lives in our row), and pushes
**webhooks** when a watch syncs.

## How it's wired

- **OAuth**: the shared `makeCloudOauth` seam with `pkce: true` — PKCE is
  opt-in per provider so Polar's live authorization URL stays byte-identical;
  Suunto (never shipped without it) sends `code_challenge` S256 to defang
  Android deep-link interception.
- **Rows**: `integration_connections` `provider = 'suunto'` —
  `external_user_id` is the Suunto app username (from the access-token JWT; maps
  webhooks back to app users), plus `refresh_token`/`expires_at` and the
  `sync_cursor` watermark. Webhook-announced workouts stage in
  `integration_staged_workouts`; FIT downloads count against
  `integration_sync_usage` (per-user daily cap, `SUUNTO_FIT_DAILY_LIMIT`,
  default 300 — the subscription key is an app-wide quota).
- **`suunto-import` edge function** (JWT-authed) actions:
  - `status` → `{connected}` (false when the row is flagged `needs_reauth`).
  - `exchange {code, redirectUri, codeVerifier}` → tokens + username, upsert.
    Re-auth of the same account keeps the cursor; a different account resets it
    to 0 and drops the old account's staged rows.
  - `sync {knownKeys?, pageSize?}` → ONE page of workout **summaries** (no FIT
    bytes — the client's global 15s Supabase fetch timeout would abort batched
    binaries): staged rows flagged `staged`, listed workouts walked ascending
    from the cursor. **Never advances the cursor.**
  - `fit {key}` → one base64 FIT, from the documented export route below.
    `gone` (404/410) is the only terminal miss; 401/403/429/5xx/network are
    `transient` so quota exhaustion can't permanently degrade runs to
    summary-only.
  - `ack {cursor, stagedKeys}` → `ack_integration_cursor` RPC (atomic
    `greatest()`, rewind-proof) + staged-row deletion. The client acks only
    AFTER runs are saved — an unacked page re-serves next scan.
  - `disconnect` → delete row + staged rows.
- **Client-side safeguards** (`providers/suunto.ts` scan loop):
  - *Calibration tripwire*: a page whose every fetched workout (≥3) maps to
    null is treated as a probable summary-schema mismatch — the scan stops
    WITHOUT acking, so a mis-calibrated field name can't silently consume the
    backfill. Logged as `possible schema mismatch`.
  - *FIT retry budget*: a workout whose FIT specifically fails 3 scans in a
    row (`rc_suunto_fit_fails`, per-device) imports as summary-only and stops
    blocking the batch — one broken workout can't wedge all later history.
    Quota/network/reauth transients never spend the budget (global, not the
    workout's fault).
  - *Run cache*: mapped runs are cached per session, so a batch whose import
    toast was ignored re-serves without re-downloading FITs (quota-neutral).
  - *No-progress break*: while runs are pending a save the server cursor is
    frozen, so the page loop stops as soon as a sync makes no progress —
    real throughput is one listing (~100 workouts) per user-confirmed scan.
  - *Summary fallback* (`suuntoWorkoutToRun`, for indoor/FIT-less workouts and
    anything the retry budget gave up on): reads each field by every name it is
    known to arrive under — the listing and the webhook's trimmed body disagree
    — and carries `totalAscent` into `elevation`. Heart rate normalises out of
    Suunto's **Hz** form (2.7 Hz = 162 bpm): anything under 15 is beats per
    second, because no workout average is 3 bpm and importing it as one would
    poison the zones, the coach and every average downstream.
  - `disconnect` resets all of this (cache, retry budget, backfill flag).
- **Cursor rules** (the load-bearing part, in `sync`):
  - The watermark is computed from **since-listed workouts only, never staged
    ones** — a staged workout is today's run arriving mid-backfill; letting it
    advance the watermark would silently skip everything in between.
  - It advances past deliberately-skipped listed workouts (non-run activity,
    `knownKeys`) so e.g. 100 consecutive rides can't wedge it.
  - Start-time based, no `+1`: equal-startTime workouts split across a page
    boundary re-list once; `knownKeys`/extId dedupe absorb it.
  - Late-upload net: at most once a day, `sync` re-lists a trailing 30-day
    window (`lastOverlapCheck` in `sync_state`) so workouts from a
    late-syncing watch — or webhooks missed during an outage (Suunto's
    circuit breaker has no replay) — self-heal.
  - **Backfill = the same protocol**: `exchange` starts the cursor at 0 and the
    client pages until `hasMore` is false.
- **`suunto-webhook` edge function** (public, `verify_jwt = false` in
  `supabase/config.toml`): verifies `X-HMAC-SHA256-Signature` over the **raw**
  request bytes with `SUUNTO_WEBHOOK_SECRET` (constant-time via
  `crypto.subtle.verify`), maps `username` → every matching connection row,
  upserts `{workoutKey, trimmed summary}` into staging, answers 200 within
  Suunto's 2-second budget (no Suunto API calls, no FIT downloads). Bad
  signature → 403; malformed-but-signed and unknown usernames → 200 (no
  account-existence oracle, nothing feeds the retry/circuit-breaker). Unset
  secret → immediate 200 before any DB access. Never logs bodies or signatures.

## API surface

Per the partner docs, all three calls are **v3**:

| Purpose | Endpoint | Used by |
| --- | --- | --- |
| List workouts | `GET /v3/workouts/?since=&until=&limit=&offset=&filter-by-modification-time=` | `sync` (`LIST_PATH`) |
| One workout | `GET /v3/workouts/{workoutKey}?extensions=` | not called — see below |
| Workout FIT | `GET /v3/workouts/{workoutIdOrKey}/fit` | `fit` (first candidate) |

The v2 listing that shipped first is kept as a fallback (`LIST_PATH_LEGACY`),
tried only when the v3 one rejects the request and logged as
`suunto-import v3 list failed, falling back to v2`. The two versions coexist on
live accounts and a listing that quietly stops working reads as "the sync button
found nothing" — the failure mode this whole file is careful about.

**Get-workout is deliberately not called.** Its `extensions` parameter can
attach stream and summary data (`LocationStreamExtension`,
`HeartrateStreamExtension`, `SummaryExtension`, `WeatherExtension`, …), but the
FIT already carries the route, the HR series and the altitude the app stores,
in one request instead of two against an app-wide quota. Reach for it only for
something the FIT genuinely lacks *and* the `Run` shape has a home for — today
that is nothing: cadence, steps, calories, temperature and weather have no
field, and inventing one is a product decision, not an import detail.

## The FIT export endpoint

**The documented route is `GET /v3/workouts/{workoutIdOrKey}/fit`** — a
different API version *and* path shape from the `/v2/workouts` listing this
function still pages.

That mismatch is the whole lesson. The original code extrapolated the export
path from the listing's (`/v2/workouts/exportFit/<key>`) and it answers **401**
with the same token and subscription key. Every import therefore took the
summary fallback, which on screen is "No route was recorded for this run" and a
distance rounded to 100 m — it never looks like an endpoint error, and the
client's retry budget turned it into a *permanent* summary-only run after three
scans. **Never infer one Suunto endpoint from another.**

The export route is therefore taken from the partner docs, not inferred:
`fitPath` in `_shared/suunto/fitExport.mjs`, pinned by
`src/imports/suuntoFitExport.test.ts`.

It briefly shipped as a self-calibrating ladder of candidate paths and auth
styles, memoised in `sync_state.fitVariant`, written while the documented route
was still unknown. The live connection calibrated to the documented route on
its first download and never fell past it, so the ladder was removed; the two
guards that were doing real work stay:

- **A 2xx is not a FIT.** The body must start with `.FIT` at bytes 8-11, or an
  APIM notice (or a JSON envelope pointing at a download URL) imports as a
  trace.
- **"Answered, but not with a FIT" gets its own log line**
  (`fit body was not a FIT`) — that points at the response shape, a different
  fix from a 401 or a 404.

## CALIBRATE on first live pass

The partner docs sit behind the API agreement; these are isolated in one helper
each and marked `CALIBRATE` in the code:

1. ~~The list endpoint path~~ — documented, see the API surface above. The
   list response wrapper (`payload`) is still inferred; the parser accepts
   `payload`, `workouts` or a bare array.
2. ~~`since` semantics~~ — start time, unless `filter-by-modification-time` is
   passed. **Switching the watermark to modification time is still worth
   doing** (it subsumes late watch syncs and makes the overlap re-list
   redundant), but it is a migration, not a flag flip: `sync_cursor` holds
   start times on live rows, and reinterpreting them against a different clock
   would skip or replay history. Needs a one-off cursor conversion, and the
   modification-time field name from a live response to feed the new
   watermark.
3. The access-token JWT's username claim (`usernameFromJwt`). *(Confirmed
   live: the `user` claim.)*
4. Webhook signature encoding — hex and base64 are both accepted
   (`decodeSignature`); confirm against the docs' example.
5. The activity-id sets (`RUN_ACTIVITY_IDS`/`WALK_ACTIVITY_IDS`) — skipped ids
   are logged (`suunto-import skipped activity ids`) so a mistyped run
   surfaces in the function logs, and the client mirror lives in
   `providers/suunto.ts`.

Each calibration miss is **logged as counts/status only** — never a key, body
or header — because from the client every one of them looks identical to "the
sync button found nothing": `suunto-import sync since=… listed=… offered=…`
per page, and `suunto-import fit failed <status>` / `fit missing <status>` per
download. Read those first; a FIT endpoint that answers nothing usable
degrades every import to summary-only (no route, no HR series, round summary
distances), and the client's retry budget hides it for three scans before it
does — that is exactly how the v2-versus-v3 mix-up above went unnoticed.

**A summary-only import does not heal itself.** Once the run is saved its key
is in `knownKeys` and the cursor has passed it, so a later fix imports nothing
for it. To recover such runs: delete them in the app, then wait for (or reset
`sync_state.lastOverlapCheck` to force) the daily 30-day overlap re-list, which
re-offers them with the working endpoint. A full re-backfill is
disconnect + reconnect.

## Activation (maintainer)

Dormant until configured, like every cloud provider. To turn it on:

1. **Apply to the Suunto partner program** (<https://apizone.suunto.com>, sign
   the API agreement; ~2 weeks). This is the schedule-critical step. You get
   the OAuth **client id/secret** and a **subscription key**
   (`Ocp-Apim-Subscription-Key`).
2. **Configure the OAuth app** at Suunto: redirect URL
   `https://run.camboulive.solutions/` (trailing slash — must equal
   `redirectUri()` in `src/imports/cloudOauth.ts` byte-for-byte), webhook
   notification URL
   `https://<project-ref>.supabase.co/functions/v1/suunto-webhook`, and a
   webhook notification secret.
3. **Server secrets**:
   `supabase secrets set SUUNTO_CLIENT_ID=… SUUNTO_CLIENT_SECRET=…
   SUUNTO_SUBSCRIPTION_KEY=… SUUNTO_WEBHOOK_SECRET=…`
4. **Client env — repo VARIABLE, not a secret**: Actions repo variable
   `VITE_SUUNTO_CLIENT_ID` (wired in `deploy.yml` / `deploy-pr.yml` /
   `release.yml` / `android-pr.yml`).
5. **Apply the migration BEFORE merging function changes**
   (`supabase db push`; functions auto-deploy on merge to `main`). On the first
   webhook deploy, confirm `verify_jwt = false` took effect (curl it without a
   JWT — a 401 means the config.toml block was ignored; see the comment there).

## Verification

Local (no credentials): `supabase functions serve` + curl — unconfigured
actions return `{skipped}`; webhook with a hand-computed HMAC lands a staged
row, a wrong signature 403s, a garbage header 403s (not 500); `sync` drains the
staged row; `ack` deletes it and `sync_cursor` only ever grows (two concurrent
acks never rewind it).

Live (after credentials): connect on web + Android (deep-link bounce, cold
start); full-history backfill pages with progress; deliberately ignore an
import toast and check the batch re-serves on the next scan with **no FIT
re-downloads** (edge logs); record a watch run → webhook stages it → next app
foreground imports it with map + HR; force `expires_at` into the past → sync
still works and the row rotates; two devices syncing concurrently → no
disconnect, no cursor rewind; disconnect wipes both tables; reconnect
re-backfills to 0 new runs.
