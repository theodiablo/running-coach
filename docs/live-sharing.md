# Live run sharing

Opt-in, free, one switch: while a run is recording, the phone broadcasts the
route so far, and anyone holding the runner's **standing share link** can watch
it happen — as can the runner's own other signed-in sessions. Off by default;
nothing is sent mid-run unless the switch is on.

**The link is the runner's, not the run's** (2026-09). It is claimed once, kept
in `live_share_tokens`, and reused by every run they share, so there is nothing
to send before a run. Replacing it is the revocation. That reverses the original
"per run, never a standing address" decision on purpose — what makes it safe is
below, and it is not the UI: it is that the token stopped being a column the
client writes.

Shipped premium-gated, then unveiled free for every signed-in account
(2026-08) — see `docs/monetization.md`. Nothing about the transport, cadence,
staleness model or cleanup below changed; only who may `insert` a row did.

Two layers, and they are authorized completely differently. The same-account
broadcast is `auth.uid() = user_id` and nothing else. The public link is a
capability token and nothing else. Neither knows about the other, which is why
the second one could be added without touching the cadence, the cleanup, or the
staleness model. Public links are **"Sharing with someone else"** below.

## Shape

| Piece | File |
|---|---|
| Table, RLS | `supabase/migrations/20260727135028_live_runs.sql`, premium gate dropped in `20260818184235_live_runs_drop_premium_gate.sql` |
| Share-token column (legacy, pre-v4) | `supabase/migrations/20260804190422_live_runs_share_token.sql` |
| Token ledger, `share_public`, `rotate_share_link` | `supabase/migrations/20260912095101_live_share_tokens.sql` |
| Claiming / replacing / caching the link | `src/live/shareLinkStore.ts` |
| Recorder (writes + cleanup) | `src/live/publisher.ts` |
| Toggle, link controls, publish effect, teardown | `src/modals/LiveRunTracker.tsx` |
| Watcher (subscribe/poll) | `src/hooks/useLiveRun.ts` |
| Dashboard banner | `src/views/Dashboard.tsx` |
| Watch display (shared by both surfaces) | `src/components/LiveWatchView.tsx` |
| In-app watch screen | `src/modals/LiveWatchModal.tsx` |
| Token minting, URL shape, public read | `src/live/shareLink.ts` |
| Token contract (Deno + browser) | `supabase/functions/_shared/liveShare.mjs` |
| Public read endpoint | `supabase/functions/live-watch/index.ts` |
| Public `/watch/:token` page | `src/watch/PublicWatch.tsx` |
| Publish token (write capability) | `src/live/publishToken.ts`, `supabase/functions/_shared/livePublish.mjs` |
| Native upload endpoint | `supabase/functions/live-publish/index.ts` + RPCs in migration `20260805062612` |
| Native uploader (Android) | `android/.../LivePublishPlugin.kt`, seam `src/geo/liveUpload.ts` |

One row per user in `live_runs` (`user_id` is the primary key), written while
the run is on and deleted when it ends.

## Why a table, not a broadcast

Every write carries the **whole simplified trace**, not a delta. That single
decision buys three things:

- a watcher who opens the app mid-run gets the full route immediately — no
  replay, no backfill path to write;
- a phone that loses signal for ten minutes heals completely on its next
  successful write, instead of leaving a permanent hole in the line;
- a failed publish needs no retry queue: the next one supersedes it.

A 1h run simplified at ε=5m is comfortably under 50KB, which is what makes
re-sending everything affordable at a 30s cadence.

Live data must never go in the `app_state` blob — that is re-upserted whole on
every state change, debounced for a completely different workload, and is
client-writable.

## Cadence: 30s, and never a timer

`LIVE_PUBLISH_INTERVAL_MS` (publisher) and `POLL_MS` (watcher) are both 30s on
purpose: **reading faster than the phone writes can only return what we already
have.** Raising one without the other just adds load.

Publishes are triggered by *accepted GPS fixes* — the same renders that already
drive the lock-screen notification — never by `setInterval`. A backgrounded
WebView throttles JS timers to a crawl, which is exactly the situation a run is
recorded in (screen off, phone in a pocket). `canPublishNow()` is checked before
`simplify()` so the ~1/s foreground clock ticks don't re-simplify a long trace
only to discard it.

The consequence is that **a stationary runner publishes nothing**: with
`distanceFilter` in play, standing still emits no fixes. That is not a bug to
fix at the recorder; the watcher owns staleness and says so on its own. Status
transitions (pause / resume / finish) bypass the throttle, because a paused run
drops fixes and would otherwise leave the watcher on a stale status indefinitely.

## Native screen-off uploads (Android)

Fix-triggered JS publishing has one hole, and on Android it is total: a
backgrounded WebView runs **no JS at all** (docs/live-tracking.md), so with the
screen off nothing publishes and a watcher sees the runner frozen at the last
screen-on position until unlock. The fix follows the lock-screen notification's
pattern — *native computes while backgrounded, JS seeds it and stays the
authority* — with an upload leg:

- **The publish token is a second per-run capability, the write half.** Minted
  in `startTracking` (never inherited within a mount — a retained native batch
  must not ride into the next run's broadcast), carried on every JS write like
  `share_public`, stored per-device (`rc_live_publish_token`, adopted on mount
  only alongside a recoverable run), spent by `endLiveRun`/the sweeps. Unlike
  the share link it is never displayed and never leaves the device except
  inside the writes it authorizes. A user JWT can't do this job: it expires
  mid-run in a process that can't refresh it.
- **`live-publish` (verify_jwt = false) can only continue a broadcast.** All
  row work is in the `live_publish_append`/`live_publish_end` RPCs — a single
  authoritative UPDATE (never SELECT-then-UPDATE, which would race the JS
  full-trace writer; never an INSERT, so an unauthenticated endpoint can never
  originate a broadcast, only extend one the JS side already opened). The
  append dedupes on the stored tail's timestamp (a
  timed-out-but-committed POST retries idempotently), clamps skewed clocks
  rather than rejecting, refuses `ended` rows, keys freshness on `updated_at`
  (6h, so a >6h ultra keeps working) with a 24h `started_at` backstop, and at
  the 20k-point cap still writes stats — freezing `updated_at` would make a
  moving runner read as "signal lost".
- **One writer at a time.** The native uploader runs ONLY while the page is
  hidden: `LiveRunTracker` arms it on `visibilitychange`→hidden (before the
  freeze) and disarms on →visible, pause, stop, toggle-off, teardown and
  unmount — directly on the bridge, never behind `liveNotification`'s queue, so
  a disable can't be stranded by an in-flight push. Foregrounded, the JS
  publisher's full-trace writes re-base everything, which is why a raw native
  tail never survives long and the head marker can never snap backwards.
- **The uploader's inputs are the patch's own numbers.** The patched
  geolocation plugin re-broadcasts every fix its fold accepts (`LIVE_FIX`,
  with km / durationSec / curPace from the same fold that renders the
  notification), so the watcher and the lock screen can't disagree and the
  acceptance gates exist in exactly one native place. `LivePublishPlugin.kt`
  buffers (bounded, thinning past 600 points), POSTs every 30s under a timed
  partial wake lock, and follows the response contract: `{live:true}` drop the
  batch; `{live:false}` soft-latch 5 min, hard-disable after 3 consecutive (a
  POST can land inside the publisher's legitimate delete-then-reinsert at run
  start); 4xx drop the poison batch; 5xx/network keep and retry. A 90-min
  seed self-expiry bounds how long uploads can outlive the app's intent.
- **Degrades, never breaks:** no token (pre-token recovery) → v2 behaviour;
  `publish_token` column not yet migrated → PGRST204 latches JS back to v2
  writes and `live-publish` 500s (a healthy uploader keeps its batch — a
  deploy-ordering gap must not read as "run ended"); signed out at save →
  `endLiveRun` tears down via `{token, end:true}`.

## No premium gate

Live sharing shipped premium-gated, then had the gate removed (2026-08) —
`docs/monetization.md`. Insert, update and delete are all own-row-only:
`auth.uid() = user_id`, nothing else. Any signed-in account may broadcast a run.

That was not always true. Insert alone used to additionally require
`public.is_premium()` in its `WITH CHECK`, while update and delete stayed
premium-free on purpose (an entitlement lapsing mid-run must not strand a row
the runner can no longer update or clean up — starting a broadcast was the
privileged act, ending one never was). The asymmetry is gone along with the
gate: `20260818184235_live_runs_drop_premium_gate.sql` dropped the check from
the insert policy, leaving all three policies the same shape. `is_premium()`
itself is untouched — it still backs the premium gates on guided workouts and
the route finder, both unaffected by this change.

**The publisher still opens a broadcast with an `insert` and continues it with
an `update`, never an upsert** — that predates the premium gate and doesn't
depend on it. An `insert` that hits the primary key (`23505`) means a leftover
row from a killed run is in the way; the publisher deletes it and re-inserts,
so a new broadcast always stamps its own `started_at` rather than inheriting
one. An `update` that matches no rows means the row was swept from under it
(or claimed by another device), and clears the flag so the next fix re-opens
the broadcast instead of publishing into a void. See `src/live/publisher.ts`.

A policy rejection (`42501`) still latches the publisher off for the rest of
the run — now reachable only by a tampered client, since every signed-in
account passes the policy honestly, but still worth latching rather than
retrying every 30s against a refusal that will never clear.

`live_runs_touch` pins `search_path` (migration `20260727183713`) — not just
lint hygiene: with a mutable one, `now()` is resolvable to something other than
`pg_catalog.now()`, handing back control of the very column the trigger exists
to make server truth.

Client-side, the toggle (`src/modals/LiveRunTracker.tsx`) is always shown and
always actionable — `toggleShareLive` just flips `LIVE_SHARE_KEY`, no
entitlement check, no teaser sheet. `useLiveRun` (the watcher half, mounted
once in `RunningCoach`) subscribes for any signed-in user, not conditionally.

## Staleness, and why the copy is careful

Silence is ambiguous *by construction*. A runner waiting at a crossing, a phone
in a tunnel, and an app the OS killed are indistinguishable from the watcher's
side. So:

- the watch screen never asserts something is wrong, it reports how long it has
  been quiet (`QUIET_MS`, 3 min, well above the 30s cadence). A **paused** run is
  excluded from that: it drops fixes by design and the pause itself was pushed
  through as a status change, so the row already says what is happening — calling
  it a lost signal would replace a definite answer with a worried guess;
- `isActive()` keeps a row live for up to 6h, mirroring the tracker's own resume
  window, so a long quiet stretch never reads as "not running";
- `updated_at` is **server-stamped** by a trigger. A client-supplied value would
  make a phone with a skewed clock look permanently stale, or permanently fresh.

The toggle hint and the privacy page both say plainly that this is not a safety
device. Keep that: an update stream that can stop without warning must never be
something a user relies on for help.

## Lifecycle and cleanup

| Event | What happens |
|---|---|
| Start (switch on) | `insert` stamps `started_at`, carries `share_public`, and marks this device the publisher |
| Pause / resume | status `update`, bypassing the throttle |
| Switch off mid-run | full teardown (`endLiveRun`) — **not** the leftover sweep, which runs once per mount and would leave an off → on → off run published until save |
| Switch back on mid-run | a new broadcast: fresh publish token, `resetLivePublisher`, re-opened on the next fix |
| Finish | status `ended` — the watcher shows the run as over rather than going quiet |
| Save or discard | row deleted (`endLiveRun`), fire-and-forget so it can never block a save |
| App killed mid-run | row survives; swept when that device next opens the app |
| Recovery discarded | swept there and then — the boot sweep already spared it |
| Start with sharing off | swept once recording begins — nothing will publish over it |

The account's **share link is never spent by any of these** — it belongs to the
account, not the run. What dies with a broadcast is the publish token and (as of
the standing link) nothing else on the sharing side.

### The sweep is scoped to the publishing device, twice over

`live_runs` is keyed by `user_id`, and **a watching session is by definition
another session of the same account**. So a delete-my-own-row sweep on boot is
indistinguishable from sabotage: opening the app to watch a run is exactly what
would take it off the air, and — because the recorder only publishes on an
accepted GPS fix — it would not come back until the runner moved again, never
while paused or standing still. The sweep is therefore gated on both:

- **`LIVE_PUBLISHED_KEY`** (per-device `localStorage`, the `started_at` of a
  broadcast this device opened and has not confirmed the deletion of). Set on the
  first successful write, cleared **only** by a confirmed delete — an optimistic
  clear would strand the row when the teardown didn't land. No marker, no sweep,
  which is every watching device.
- **the row still carrying that `started_at`.** If it doesn't, another device has
  since started its own broadcast over ours; leave it and drop the marker.

`clearStaleLiveRun()` (boot) additionally **skips** while a recoverable run buffer
exists in `localStorage`: that run can still be resumed, and a watcher may be
following it right now. Resolving that deferral is what the last three rows of
the table above are for — otherwise a row spared on boot would sit on the air for
the full 6h window. The buffer check applies the same freshness cutoff
(`RESUME_MAX_AGE_MS`) the tracker uses before offering the resume, or a buffer too
old to ever be offered would block the sweep forever.

`shareEndedRef` in the tracker stops a re-render after teardown from resurrecting
the row with one last `ended` write, and `endLiveRun()` **awaits any write already
on the wire** before deleting — the `ended` write fired on Stop carries the whole
trace, and a delete that overtakes it is undone the moment it lands.

## Load discipline on the watcher

In order of preference: one snapshot read → Realtime pushes → polling only as a
fallback, and only while Realtime is down and the page is visible.

The poll is **not** gated on a run being live, tempting as that is: with Realtime
down, "a run is live" can only ever become true through that same poll, so gating
on it means a run starting after page load is invisible until something else
happens to trigger a read. The gate is a cadence instead — the publisher's 30s
while a run is live, `IDLE_POLL_MS` (2 min) while nothing is — and it stops
entirely when the tab is hidden, since `visibilitychange` catches up on return.

The snapshot read is made from the `subscribe` callback rather than before it,
so an update landing between the read and the subscription can't slip through
the gap. It runs on a failed status too, so a blocked websocket still gets its
initial read before falling through to polling.

The hook is mounted **once**, in `RunningCoach`, and threaded through the
`shared` bag — two consumers (banner + modal) must not open two channels. It
subscribes for any signed-in `uid`, whether or not that account has ever used
live sharing; most reads simply come back empty.

## Known limits

- **Two devices recording the same account** share one row, last writer wins
  (the second one's `insert` hits `23505`, clears the first, and takes over).
  Not defended against — recording the same run twice is already incoherent.
- **A row survives a device that never opens the app again.** The sweep runs on
  the publishing device, so nothing collects for an uninstalled or dead phone;
  watchers stop showing it after 6h (`isActive`), but the row itself remains. A
  scheduled server-side delete of rows past that window is the fix if this ever
  matters — it needs `pg_cron`, which this project doesn't currently use. The
  **public** side is not exposed by this: `live-watch` applies the same 6h cutoff
  server-side, so a link goes dark on its own even when nothing sweeps the row.
- Freshness is computed against the watcher's local clock, so a badly skewed
  watching device mislabels "x ago". Server-stamping `updated_at` bounds this to
  the watcher's own skew.
- The recording device suppresses its own banner (`showTracker`), but a *second*
  session on the same account that also opens the tracker is not coordinated.

## Sharing with someone else

A public link, opt-in per run, on top of the pipeline above rather than beside
it: the recorder, the cadence, the cleanup and the staleness copy are all
unchanged. The only new idea is **who may read the row**.

### The token is the capability, not an identifier

The token is 128 bits from `crypto.getRandomValues`, base64url, minted on the
phone (`mintShareToken`) and claimed in `live_share_tokens`. Whoever holds
`/watch/<token>` may watch; being signed in grants nothing extra and is not
required. That single
decision answers both of the questions this feature raises:

- **Crawling** is defeated by entropy, not by obscurity or rate limiting. At a
  million guesses a second, finding any one live run takes longer than the
  universe has existed. Everything else here — `noindex`, `Disallow: /watch/`,
  the per-IP limit — is defence in depth, and none of it is load-bearing.
- **Signed-in versus signed-out stops being a question.** There is one page, not
  two experiences: the session authorizes nothing, so there is nothing to
  branch on. `PublicWatch` never imports `src/supabase.ts` at all.

The shape is a security parameter, so it is pinned in four places that must
agree: the minting client, the `live_share_tokens.token` CHECK constraint, the
legacy `live_runs_share_token_shape` CHECK constraint, and the edge function's
validation. All of them read `supabase/functions/_shared/liveShare.mjs` or a
constraint that mirrors it — don't let them drift.

### One uniform response, and what it buys

The `live-watch` edge function answers `{ live: false }` — byte for byte the
same — for **all** of: a malformed token, a well-formed token that doesn't
exist, a token whose run hasn't started, a swept row, and a row past the 6h
freshness window. A crawler therefore cannot even learn whether a token exists,
so there is no oracle to grind against.

The same property is the pre-run experience, for free: a runner can send the
link the night before a race, and the page says nothing is live yet **because
that is true**. It starts showing the run the moment they set off, with no
special "pending link" state to build or expire.

The one deliberately non-uniform response is a `429`: someone whose household
NAT hit the limit needs to know to wait, not to believe the run ended.

### Why an edge function and not a token-scoped RLS policy

Both were on the table. The function wins on four counts:

- **`user_id` is the table's primary key.** A direct anon read hands every
  viewer the runner's account UUID, permanently, for a link about one run. The
  function's select list omits it, and nothing else identifies the account —
  no name, no avatar, no hint. The page shows a run, not a person.
- **RLS can't see a query parameter**, so a policy version means smuggling the
  token through a request header: more moving parts for a weaker result.
- **The uniform response and the rate limit are code**, not policy.
- **Realtime is unavailable to an anonymous viewer anyway** (the table has no
  anon-readable policy at all, by design), so the public page polls — and per
  the cadence rule above, reading at the publisher's own 30s loses nothing.

### One standing address, and what keeps it safe

A stable "my live link" was rejected when public links shipped, in these words:
*"shared once with the wrong person, it becomes a standing window onto wherever
that person runs, forever."* That is still true of the naive version of this
feature. Two words in it are load-bearing, and each has an answer:

- **"Forever"** is bought back by **Replace link**, one tap in the pre-run panel
  (and in Settings → Account, because the moment you want to cut someone off is
  rarely the moment you are about to run). It is immediate and server-side: the
  ledger stops resolving the old token for everyone holding it, with no wait for
  the runner's next publish. The old token is **retired, never freed** — a
  tombstone kept forever, because a released token could be re-claimed by
  someone still holding the old link, which is the same spoof through a
  different door. `live-watch` therefore looks the token up *unfiltered*: a row
  that exists but is revoked is a terminal "nothing live" and must never fall
  through to the legacy column.
- **"Standing window"** is bounded by what the link can ever show: a run, while
  it is recording, with the switch on. No history, no position at rest, no
  identity — the function's select list still omits `user_id`, and nothing else
  on the row names the account. Between runs the link answers the same
  `{ live: false }` as a token that never existed.

The mechanics that hold it together:

- **The token is claimed, not carried.** `live_share_tokens` keys tokens by the
  token itself (so uniqueness *is* the primary key) with one active row per user
  (a partial unique index) and `user_id` nullable + `on delete set null`, so
  deleting an account cannot free that account's tokens for re-claim.
- **The client may insert, and retire — nothing else.** `revoke all … from
  anon, authenticated`, then `grant select, insert (user_id, token)` plus
  `update (revoked_at)` behind the one-way policy above. No delete, ever, and no
  write to `token`, `user_id` or `created_at`, so a tombstone stays a tombstone
  and cannot be un-revoked. The explicit revoke is not hygiene:
  `auto_expose_new_tables` is unset (`supabase/config.toml`), so a new table
  gets no grants on the hosted project and `GRANT ALL` on the local stack, and
  without stating the posture we would test one privilege set and ship another.
- **Rotation is the one function.** PostgREST gives every request its own
  transaction, so a client-side revoke-then-insert can strand an account with no
  link at all; `rotate_share_link` does both or neither. `security invoker`,
  `set search_path = ''`, fully-qualified references: it exists for atomicity,
  not privilege, and the new token still comes from the phone's CSPRNG. It also
  caps the ledger at 100 rows per account, because tombstones-forever without a
  ceiling is an unbounded authenticated write primitive; the cap surfaces as its
  own copy rather than as a connection error, which is what it is not.
  **Because it is `invoker`, it can only retire a row the CALLER may retire** —
  which is why the ledger grants `update (revoked_at)` and carries a one-way
  UPDATE policy (`using revoked_at is null` / `with check revoked_at is not
  null`). The first migration granted neither, so the function's own UPDATE
  raised `42501` and Replace link could not work at all; nothing in CI could see
  it, because the client test mocks the RPC and there are no database tests.
  Tombstone immutability is unchanged — one column, one direction.
- **First creation needs no function** — a single statement is atomic on its
  own. Its two distinct 23505s get different answers: the active-row index means
  another device claimed one first (re-read theirs), the primary key means a
  128-bit collision (re-mint). Never `Prefer: resolution=ignore-duplicates`,
  which would swallow either and leave the panel displaying a token it does not
  own.
- **The per-device copy is a cache, never the truth.** `LIVE_SHARE_LINK_KEY`
  holds `{uid, token}` so the panel renders offline; it is keyed by uid (a shared
  device must not show the previous runner's address) and cleared on sign-out
  (`App.tsx`), alongside the offline state mirror. A **new** key on purpose:
  every installed device still holds a spent per-run token under the v2 name.
  The panel revalidates against the ledger on mount and on every return to the
  foreground, and will not offer **Send link** for a token it has not confirmed
  this session — a link replaced on another device would otherwise be handed out
  as a permanently dead address.

Accepted costs, so they are not rediscovered as bugs:

- **Minting needs the network.** A link is never displayed before the ledger
  confirms it, so a runner who has never created one cannot create it at a
  trailhead with no signal. The previous design minted locally and healed on the
  next write; this one trades that for an address that cannot be squatted.
- **An insert-existence oracle.** A client picks its own token, so a `23505`
  tells an authenticated prober that one is claimed, where `live-watch`'s
  response is uniform. Hopeless at 128 bits, and blind through that channel to
  whether a token is active or retired, since tombstones answer identically
  (the latency above is the one place that leaks).
- **A timing difference, and it is the retired token that shows.** A claimed
  token costs two lookups (ledger + row) and so does an unknown one (ledger +
  the legacy column); a **retired** one returns after a single lookup. So the
  measurable bit is "this token was rotated away" — not "this token exists",
  which stays hidden. Narrow, unexploitable, and worth stating rather than
  leaving the neighbouring oracle bullet to imply the retired case is
  indistinguishable by every measure: through the *response* it is.

### The flag rides the normal writes

`share_public` is on every insert and every update, and **a change to it
bypasses the 30s throttle** exactly like a status transition does. Hiding a run
has to take it off the link *now* rather than up to 30s from now, and it is not
driven by GPS — a runner standing at a crossing emits no fixes to carry it out
later.

The token itself no longer rides anything: it lives in the ledger, and nothing
in the run row names it. That is what killed an entire class of failure the
per-run design lived with — **the squat**. `live_runs.share_token` is
client-writable under a table-wide unique index, so anyone handed a link could
claim that token on their own row at any moment the runner's row didn't exist,
which is most of the day. For a token that died in an hour that cost a
re-share (the publisher dropped it and kept broadcasting). For a durable address
it would be a permanent denial *and* a spoof: everyone holding the link would
watch the squatter's run under an address they trust. With the claim held
permanently in the ledger, first-come and unique, there is nothing to take —
and `writeRow` loses the whole 23505-on-`share_token` branch with it.

One piece of that ordering survives, though: a conflict naming
`live_runs_share_token_key` must still never be read as "my own leftover row".
An **older bundle on another device of the same account** still writes that
column, so the index can still reject our insert, and treating it as a leftover
would delete a perfectly good live row.

Legacy retirement: `live-watch` still resolves a pre-v4 `share_token` when the
ledger has no row for it at all, so links minted by an older bundle keep working
for their own run. Retire that branch — and revoke the column's write — in a
follow-up migration once `min_supported_version` clears the last bundle that
mints one. Old APKs persist for weeks; a release count is the wrong trigger.

### The public page

`/watch/:token` is the app's one route, and the branch lives in `main.tsx`
**before `<App/>` mounts** — App's first effects resolve the auth session and
load the per-user store, and none of that has any business running for a
stranger following a link. It's a lazy chunk behind `ChunkLoadBoundary`, and
`VITE_NATIVE_BUILD` folds it to `null` so Rollup drops it from the APK entirely
(the `MarketingGate` pattern). CloudFront already rewrites unknown paths to
`index.html`, so no infra change was needed.

**Being the one nested path, it is also the only route where `base` matters, and
a relative one breaks it completely.** `vite.config.ts` shipped `base: './'`, so
index.html referenced `./assets/index-<hash>.js`. The browser resolves that
against the *current path*: correct at `/`, but at `/watch/<token>` it requests
`/watch/assets/index-<hash>.js`, which the SPA fallback answers with index.html,
and a `type="module"` script served as `text/html` is refused outright. **Nothing
ran** — not React, not `ErrorBoundary`, not `ChunkLoadBoundary`'s fallback to
`<App/>`, not the PostHog SDK — so every shared link was a blank white page that
also reported no error, because the code that would have reported it was inside
the script that never loaded. (The `text/html` MIME errors PostHog *does* carry
are the unrelated stale-chunk kind, all logged from `/`.)

The base is therefore a property of the **deploy**, not a constant, and each
target declares its own (`vite.config.ts`, pinned by `src/assetBase.test.ts`):
production web `/` (bucket root), PR previews `/pr/<n>/` (`VITE_BASE`, set in
`deploy-pr.yml` — the default `/` would aim a preview's index.html at
production's bundle, whose hashed filenames it does not share, reproducing the
same white page under the prefix), and the shells `./`, which is safe only
because they load off a local origin root and serve no nested route at all.

One consequence worth knowing before reaching for a preview to test this page:
CloudFront's fallback returns the **bucket root** index.html, ignoring the
prefix, so `/pr/<n>/watch/<token>` serves *production's* build. Deep-link
routing is a production-only property; previews are entered at their
`index.html`. Any future nested route inherits both halves of this.

The display is `LiveWatchView`, shared with the in-app modal. That sharing is
about the **staleness model**, not the layout: silence is ambiguous by
construction, and a second copy of this screen would eventually start guessing.

`PublicWatch` owns only what the modal can't: the polling loop (a
self-scheduling chain, so the delay can change with what came back and a slow
response can't stack), a `{ kind: "error" }` that is kept strictly distinct from
`{ kind: "none" }` — a dropped connection rendered as a finished run is the one
lie this page could tell — and `noindex, nofollow` + `referrer: no-referrer`
while it is mounted, so a link pasted into a public thread isn't indexed and the
token never leaves in a `Referer` header.

**The finished run stays on screen.** Stop publishes `ended` with the whole
trace; Save then deletes the row. The page latches that ended snapshot: once it
has *seen* `status: "ended"`, a later `{ live: false }` keeps the finished route
and final stats up instead of dropping to "nothing live". It keeps **reading at
the idle cadence**, though, and does not stop for good: the address is the
runner's, so the same link lights up again the next time they go out, and a page
left open must not sit on a finished run forever. The latch arms **only on an
explicitly seen `ended`**, never on a mere live→gone transition: replacing the
link mid-run (which never writes `ended`) still takes an already-open page dark,
and a visitor arriving after cleanup still gets the uniform nothing. The in-app `LiveWatchModal` holds the same Stop
snapshot while open, so the Realtime DELETE that follows Save doesn't blank it.

Known cost: the watch chunk is small, but a visitor still downloads the main app
bundle to get to it, exactly as a signed-out visitor does for the marketing
landing. Splitting the entry would make `App` lazy for everyone, which is a
worse trade today.

### French register

The public page is read by strangers, not by users of the app, so
`liveShare.public.*` uses **`vous`** — the marketing convention, not the app's
`tu`. The runner-facing `liveShare.link.*` keys stay on `tu`. Spanish stays
informal throughout. The shared `liveShare.watch.*` copy is register-neutral in
French on purpose, because both surfaces render it.

### Not done, deliberately

- **No start-point trimming.** The trace usually begins at home, and Strava-style
  "hide the first 200m" is the obvious follow-up. It was left out because this
  link is explicit, per run, and dies at the end — unlike a public activity feed,
  which is what that feature exists for.
- **No native deep link.** If the shells ever claim the domain with universal
  links, tapping `/watch/...` would open an app that has no route for it. Nothing
  to do until then; note it in `docs/live-tracking.md` when that day comes.
