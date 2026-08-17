# Suunto cloud import

Second vendor-cloud import provider, on the seam Polar established
(`docs/integrations-polar.md`): a client `ImportProvider`
(`src/imports/providers/suunto.ts`) + edge functions holding every secret +
service-role-only rows in the generic `integration_connections` table. What's
new versus Polar: Suunto issues **short-lived tokens** (refresh flow), serves
**FIT files** (parsed client-side by the existing `parseFitFile`), has **no
server-side transaction** (so the sync cursor lives in our row), and pushes
**webhooks** when a watch syncs.

**Premium-gated (landed premium-first, docs/monetization.md).** Unlike Polar,
Suunto has never shipped to a free user, so it lands behind the premium seam
from the start rather than being clawed back later. `suunto-import` gates
every action except `status`/`disconnect` behind `isPremiumUser` (same
`profiles.premium_until` check as `route-suggest`) — a free caller's
`exchange` (and, defensively, `sync`/`fit`/`ack`) answers
`{code:"PREMIUM_REQUIRED"}`. The client mirrors this in `ConnectionsCard`: the
Suunto row only renders when `isPremium || canShowPremiumTeaser` (currently
`false`), so a free user sees no Suunto entry point at all — the same
"nothing at all" free UX as the route finder. `suunto-webhook` stays ungated:
with `exchange` shut for free callers there is no connection row for a
webhook to map a free user's workouts into.

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
  - `fit {key}` → one base64 FIT, from the **self-calibrating** export endpoint
    below. `gone` (404/410 on the *calibrated* endpoint) is the only terminal
    miss; 401/403/429/5xx/network — and every miss before calibration — are
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

## The FIT export endpoint calibrates itself

The first live pass proved why this one couldn't stay a guess:
`/v2/workouts` listed workouts fine while `/v2/workouts/exportFit/<key>`
answered **401** with the same token and subscription key. Every import
therefore took the summary fallback, which on screen is "No route was recorded
for this run" and a distance rounded to 100 m — it never looks like an endpoint
error, and the client's retry budget turned it into a *permanent* summary-only
run after three scans.

So `suunto-import` walks the candidates in `_shared/suunto/fitExport.mjs`
(singular `workout` first — Suunto names the operation
`export-user-workout-in-fit`, and only the listing is plural — and both the
`Bearer` and bare-JWT auth styles, since Suunto's own getting-started curl
passes the token bare) and remembers the one that returned real FIT bytes in
`sync_state.fitVariant`. Afterwards every download is one request, with the
other candidates left behind it as the net for the day the endpoint moves.

Two rules keep the memo honest, both pinned by
`src/imports/suuntoFitExport.test.ts`:

- **A 2xx never calibrates on its own** — the body must start with `.FIT` at
  bytes 8-11, or an APIM notice would be remembered as the export path.
- **404/410 is terminal only on the calibrated endpoint.** Before calibration
  it equally means no candidate was right, so it stays `transient`.

Watch for `suunto-import fit endpoint calibrated <variant>` in the function
logs on the first successful download.

## CALIBRATE on first live pass

The partner docs sit behind the API agreement; these are isolated in one helper
each and marked `CALIBRATE` in the code:

1. The list endpoint path (`LIST_PATH`) and the list response wrapper
   (`payload`). *(Confirmed live: `/v2/workouts?since=&limit=` under
   `payload`.)*
2. `since` semantics + sort order. **If a modification-time filter exists,
   switch the watermark to it** — that subsumes late uploads and the overlap
   re-list becomes redundant.
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
does — that is exactly how the 401 above went unnoticed.

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
