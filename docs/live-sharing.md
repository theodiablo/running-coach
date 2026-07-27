# Live run sharing

Opt-in, per run, premium: while a run is recording, the phone broadcasts the
route so far so the runner's **own other signed-in sessions** can watch it
happen. Off by default; nothing is sent mid-run unless the toggle is on.

**v1 is same-account only.** There are no share links and no anonymous access,
which is the whole reason this ships as one small table: `auth.uid() = user_id`
is the entire authorization story. Sharing with someone else is a v2 built on
the same pipeline (see the end of this file).

## Shape

| Piece | File |
|---|---|
| Table, RLS, premium gate | `supabase/migrations/20260727135028_live_runs.sql` |
| Recorder (writes + cleanup) | `src/live/publisher.ts` |
| Toggle + publish effect + teardown | `src/modals/LiveRunTracker.tsx` |
| Watcher (subscribe/poll) | `src/hooks/useLiveRun.ts` |
| Dashboard banner | `src/views/Dashboard.tsx` |
| Watch screen | `src/modals/LiveWatchModal.tsx` |

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

**Supabase's security advisor flags `is_premium()`** as a `SECURITY DEFINER`
function executable by `authenticated`, reachable at `/rest/v1/rpc/is_premium`.
That is expected and must stay: `authenticated` needs `EXECUTE` or the insert
policy cannot evaluate it. It leaks nothing — being argument-free, it only ever
reports the caller's own tier, which they can already read from their own
`profiles` row. Do not "fix" it by revoking EXECUTE; that silently breaks
starting a broadcast.

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
  matters — it needs `pg_cron`, which this project doesn't currently use.
- **A lapsed account that keeps a row alive** can go on updating it: that is the
  direct cost of the premium-free UPDATE policy, and it is bounded — the row is
  deleted when the run ends, and re-opening one is an `insert`, which is gated.
- Freshness is computed against the watcher's local clock, so a badly skewed
  watching device mislabels "x ago". Server-stamping `updated_at` bounds this to
  the watcher's own skew.
- The recording device suppresses its own banner (`showTracker`), but a *second*
  session on the same account that also opens the tracker is not coordinated.

## v2: sharing with someone else

The pipeline doesn't change — only who may read the row. Add a token column plus
a token-scoped select policy (or an edge function that reads it with the service
role), and a `/watch/:token` entry point, which is the first thing in this app
that would need routing. Everything above — cadence, staleness model, cleanup,
copy — carries over unchanged.
