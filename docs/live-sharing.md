# Live run sharing

Opt-in, per run, premium: while a run is recording, the phone broadcasts the
route so far so the runner's **own other signed-in sessions** can watch it
happen — and, if they mint a share link, so can anyone they send it to. Off by
default; nothing is sent mid-run unless the toggle is on.

Two layers, and they are authorized completely differently. The same-account
broadcast is `auth.uid() = user_id` and nothing else. The public link is a
capability token and nothing else. Neither knows about the other, which is why
the second one could be added without touching the cadence, the cleanup, or the
staleness model. Public links are **"Sharing with someone else"** below.

## Shape

| Piece | File |
|---|---|
| Table, RLS, premium gate | `supabase/migrations/20260727135028_live_runs.sql` |
| Share-token column | `supabase/migrations/20260804190422_live_runs_share_token.sql` |
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
  `share_token`, stored per-device (`rc_live_publish_token`, adopted on mount
  only alongside a recoverable run), spent by `endLiveRun`/the sweeps. Unlike
  the share token it is never displayed and never leaves the device except
  inside the writes it authorizes. A user JWT can't do this job: it expires
  mid-run in a process that can't refresh it.
- **`live-publish` (verify_jwt = false) can only continue a broadcast.** All
  row work is in the `live_publish_append`/`live_publish_end` RPCs — a single
  authoritative UPDATE (never SELECT-then-UPDATE, which would race the JS
  full-trace writer; never an INSERT, so the premium model is preserved by
  construction). The append dedupes on the stored tail's timestamp (a
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

## Premium gate

The gate is the **insert** policy — `auth.uid() = user_id and public.is_premium()`
— not client code. `is_premium()` takes no argument on purpose: a parameterised
version would let any signed-in user probe someone else's tier.

Update and delete are own-row-only **without** the premium check. That asymmetry
is deliberate: an entitlement lapsing mid-run must not strand a row the runner
can no longer update or clean up. Starting a broadcast is the privileged act;
ending one never is.

**That asymmetry only exists if the client writes the two paths separately, so
the publisher opens a broadcast with an `insert` and continues it with an
`update` — never an upsert.** PostgREST's `upsert` is `INSERT ... ON CONFLICT DO
UPDATE`, and Postgres checks an INSERT policy's `WITH CHECK` *"for all rows
proposed for insertion, regardless of whether or not they end up being
inserted"* — so an upsert is premium-gated on the **update** path too. Written
that way, a grant lapsing mid-run 42501s, latches `blocked`, and takes the run
off the air: precisely the outcome the premium-free UPDATE policy was written to
prevent. Do not "simplify" the two calls back into one.

An `insert` that hits the primary key (`23505`) means a leftover row from a
killed run is in the way; the publisher deletes it and re-inserts, so a new
broadcast always stamps its own `started_at` rather than inheriting one. An
`update` that matches no rows means the row was swept from under it, and clears
the flag so the next fix re-opens the broadcast instead of publishing into a void.

A policy rejection (`42501`) latches the publisher off for the rest of the run,
so a tampered client or a lapsed grant doesn't retry every 30s forever.

**`is_premium()` is callable by `authenticated`, at `/rest/v1/rpc/is_premium`,
and must stay that way** — the insert policy is evaluated as the querying role,
so revoking `EXECUTE` silently breaks starting a broadcast. It leaks nothing:
argument-free, it only ever reports the caller's own tier, which they can
already read from their own `profiles` row. Supabase's advisor used to flag it
under lint 0029 (`SECURITY DEFINER` reachable by signed-in users); migration
`20260805084721` switched it to **`SECURITY INVOKER`**, which clears the finding
and is sound precisely because it reads nothing beyond the caller's own
RLS-visible row. Keep it INVOKER — DEFINER buys nothing here.

`live_runs_touch` pins `search_path` (migration `20260727183713`) — not just
lint hygiene: with a mutable one, `now()` is resolvable to something other than
`pg_catalog.now()`, handing back control of the very column the trigger exists
to make server truth.

Client-side, the toggle is gated on `isPremium || canShowPremiumTeaser` (never
`isPremium` alone), so the whole tier still reveals by flipping that one flag.
Tapping it while apparently free re-reads the entitlement and decides on that
read — the sign-in fetch may have failed offline or predated a grant.

**Publishing and the on-air indicator are gated on that same expression, not on
the stored choice alone.** `LIVE_SHARE_KEY` persists per device, so an
entitlement that lapsed between runs would otherwise leave a permanent
"Share live · On" badge with no toggle on screen to clear it, over a broadcast
RLS is refusing anyway. The stored choice only counts while the control that sets
it is visible; it re-arms by itself if premium comes back.

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
| Start (toggle on) | `insert` stamps `started_at` and marks this device the publisher |
| Pause / resume | status `update`, bypassing the throttle |
| Finish | status `ended` — the watcher shows the run as over rather than going quiet |
| Save or discard | row deleted (`endLiveRun`), fire-and-forget so it can never block a save |
| App killed mid-run | row survives; swept when that device next opens the app |
| Recovery discarded | swept there and then — the boot sweep already spared it |
| Start with sharing off | swept once recording begins — nothing will publish over it |

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
`shared` bag — two consumers (banner + modal) must not open two channels. It is
enabled only for premium accounts: a row cannot exist for anyone else, so
subscribing would be a read per app load that can never return anything.

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
- **A lapsed account that keeps a row alive** can go on updating it: that is the
  direct cost of the premium-free UPDATE policy, and it is bounded — the row is
  deleted when the run ends, and re-opening one is an `insert`, which is gated.
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

`live_runs.share_token` is 128 bits from `crypto.getRandomValues`, base64url,
minted on the phone (`mintShareToken`). Whoever holds `/watch/<token>` may
watch; being signed in grants nothing extra and is not required. That single
decision answers both of the questions this feature raises:

- **Crawling** is defeated by entropy, not by obscurity or rate limiting. At a
  million guesses a second, finding any one live run takes longer than the
  universe has existed. Everything else here — `noindex`, `Disallow: /watch/`,
  the per-IP limit — is defence in depth, and none of it is load-bearing.
- **Signed-in versus signed-out stops being a question.** There is one page, not
  two experiences: the session authorizes nothing, so there is nothing to
  branch on. `PublicWatch` never imports `src/supabase.ts` at all.

The shape is a security parameter, so it is pinned in three places that must
agree: the minting client, the `live_runs_share_token_shape` CHECK constraint,
and the edge function's validation. All three read
`supabase/functions/_shared/liveShare.mjs` or the constraint that mirrors it —
don't let them drift.

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

### Per run, never a standing address

The token is minted per broadcast and **the row's deletion is the revocation** —
the existing cleanup does the work with nothing added. A stable "my live link"
was rejected on purpose: shared once with the wrong person, it becomes a
standing window onto wherever that person runs, forever.

The mechanics that keep that true:

- `LIVE_SHARE_TOKEN_KEY` holds the current run's token per device. `endLiveRun`
  and `sweepOwnLiveRun` both spend it — a token outliving its run would be
  republished by the *next* one, silently reopening a link for a run the runner
  never shared.
- `resetLivePublisher` deliberately does **not** clear it: a run recovered after
  the app was killed has to republish under the link already sent out.
- The tracker adopts a stored token on mount **only when there is a run to
  recover** — the same condition that spares the row from the boot sweep.
  Otherwise a fresh tracker starts with no link, so a token left by a run that
  never started can't be inherited by an unrelated later one.
- Revoking mid-run writes `share_token = null` without ending the broadcast: the
  runner's own sessions keep following it, and the public page goes back to
  saying nothing is live — indistinguishable, again, from a token that never
  existed.

### The link names the web origin, not the shell's

`watchUrl` builds `<origin>/watch/<token>`, and on native the origin can't come
from `window.location`: the shells serve the bundle locally
(`https://localhost` on Android, `capacitor://localhost` on iOS), so a link
minted from it is an address only that phone can open — Android shipped
`https://localhost/watch/<token>` for exactly this reason. `shareOrigin()`
returns `WEB_APP_ORIGIN` under `isNative` (the same rule as the Polar
`redirect_uri`), which is also the only place the page exists: `VITE_NATIVE_BUILD`
drops the watch chunk from the shells entirely. Web keeps its current origin, so
a dev build still links to the dev server.

### The token rides the normal writes

`share_token` is on every insert and every update, and **a change to it bypasses
the 30s throttle** exactly like a status transition does. Minting is an explicit
act the runner is about to act on, and revoking has to take effect now rather
than up to 30s from now; neither is driven by GPS, so nothing else would push it
out promptly.

Someone who was handed a link can squat that token on their own row. The unique
index would then reject the original runner's next write forever, so a token
conflict (23505 naming `live_runs_share_token_key`) is retried **without** the
token and reported to the UI. Losing the link is acceptable; losing the
broadcast is not — the run still records and still reaches the runner's own
sessions. Note the ordering in `writeRow`: the "delete my leftover row" retry is
gated on the conflict *not* being a token conflict, or a squat would make the
publisher delete a perfectly good row of its own.

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

The base is now root-absolute on web and relative only under
`VITE_NATIVE_BUILD`, where the shells load off a local origin and never serve
this route. `src/assetBase.test.ts` pins both legs. Any future nested route
inherits the same requirement — a route one level deep is not free when
index.html is a static artifact shared by every path.

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
and final stats up instead of dropping to "nothing live", and the polling chain
stops for good — the token is spent with the row, so nothing can ever appear
under it again. The latch arms **only on an explicitly seen `ended`**, never on
a mere live→gone transition: revoking the link mid-run (which never writes
`ended`) still takes an already-open page dark, and a visitor arriving after
cleanup still gets the uniform nothing. Deletion remains the revocation; the
latch is purely client memory. The in-app `LiveWatchModal` holds the same Stop
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
