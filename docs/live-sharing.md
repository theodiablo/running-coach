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
| Recorder (upserts) | `src/live/publisher.ts` |
| Toggle + publish effect + teardown | `src/modals/LiveRunTracker.tsx` |
| Watcher (subscribe/poll) | `src/hooks/useLiveRun.ts` |
| Dashboard banner | `src/views/Dashboard.tsx` |
| Watch screen | `src/modals/LiveWatchModal.tsx` |

One row per user in `live_runs` (`user_id` is the primary key), upserted while
the run is on and deleted when it ends.

## Why a table, not a broadcast

Every upsert carries the **whole simplified trace**, not a delta. That single
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

A policy rejection (`42501`) latches the publisher off for the rest of the run,
so a tampered client or a lapsed grant doesn't retry every 30s forever.

Client-side, the toggle is gated on `isPremium || canShowPremiumTeaser` (never
`isPremium` alone), so the whole tier still reveals by flipping that one flag.
Tapping it while apparently free re-reads the entitlement and decides on that
read — the sign-in fetch may have failed offline or predated a grant.

## Staleness, and why the copy is careful

Silence is ambiguous *by construction*. A runner waiting at a crossing, a phone
in a tunnel, and an app the OS killed are indistinguishable from the watcher's
side. So:

- the watch screen never asserts something is wrong, it reports how long it has
  been quiet (`QUIET_MS`, 3 min, well above the 30s cadence);
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
| Start (toggle on) | first upsert stamps `started_at` |
| Pause / resume | status upsert, bypassing the throttle |
| Finish | status `ended` — the watcher shows the run as over rather than going quiet |
| Save or discard | row deleted (`endLiveRun`), fire-and-forget so it can never block a save |
| App killed mid-run | row survives; `clearStaleLiveRun()` sweeps it on next boot |

The boot sweep **skips** when a recoverable run buffer exists in `localStorage`:
that run can still be resumed, and a watcher may be following it right now.

`shareEndedRef` in the tracker stops a re-render after teardown from resurrecting
the row with one last `ended` upsert.

## Load discipline on the watcher

In order of preference: one snapshot read → Realtime pushes → 30s polling only
as a fallback. The poll runs **only** when Realtime is down *and* a run is
actually live; polling for a row we know isn't there buys nothing, so with
nothing live we just re-read on `visibilitychange`.

The snapshot read is made from the `subscribe` callback rather than before it,
so an update landing between the read and the subscription can't slip through
the gap. It runs on a failed status too, so a blocked websocket still gets its
initial read before falling through to polling.

The hook is mounted **once**, in `RunningCoach`, and threaded through the
`shared` bag — two consumers (banner + modal) must not open two channels. It is
enabled only for premium accounts: a row cannot exist for anyone else, so
subscribing would be a read per app load that can never return anything.

## Known limits

- **Two devices recording the same account** share one row, last writer wins.
  Not defended against — recording the same run twice is already incoherent.
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
