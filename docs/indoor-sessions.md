# Indoor / static cardio sessions

Recording a stationary bike or elliptical session, where the machine tells us
nothing and heart rate is the whole signal. Read this before touching the
indoor recorder, the `OTHER` run type, or any aggregate that means "running".

## The shape: `type:"OTHER"`, `km:0`, HR on the side

An indoor session is a **cross-training run row**, not a new type:

```
{ date, type:"OTHER", km:0, durationSec, hr, hrMax,
  activity, source:"indoor", bestEfforts:{}, startedAt, hrRouteId }
```

`OTHER` was already the cross-training type — `buildPlan`'s optional
bike/swim/elliptical day emits it (`composeLowfreq`, `sd:{kind:"cross"}`), it is
already in `NON_RUNNING_TYPES` so it can never enter the best-effort pool, and it
already has `TCLR`/`TBG`/i18n entries. Adding a `BIKE` type would have meant
touching the coach validator's `SESSION_TYPES`, `SWAP_TYPES`, `SESSION_ZONES`,
`runBarColor` and both import mappers to re-derive properties `OTHER` already
has. `activity` (`RunActivity`: bike | elliptical | rower | other) carries the
only thing `OTHER` doesn't say.

**`km` is 0, always, and there is no field to type one into.** A bike's distance
is not a running distance: letting it in would distort weekly volume, average
pace, the pace trend, PBs and the race predictor. The session's value is its
duration and its heart rate. This is the one rule not to relax — everything
below depends on it.

The manual form used to be the exception, and it cost us: it offered
"Distance (km, optional)" on an `OTHER` run, and a distance typed there reached
the dashboard's weekly/total km, History's total, `computeBadges` (including
*longest run*), `recommendStyle`'s weekly-volume signal and `buildPlan`'s
fitness floor — five places that summed `r.km` without asking what kind of run
it was. `RunFields` now renders no distance input for `OTHER`,
`runFormToPatch` zeroes any value left over from a type switch, and those five
aggregates filter on `isCrossTraining`. Both halves matter: the form stops new
contamination, the filters neutralise rows already saved.

`bestEfforts:{}` is stamped **deliberately**, not as a by-product of an empty
track: an absent field means "never measured" and invites the one-time backfill,
`{}` means "measured, covers no standard distance" and closes it (`src/types.ts`).

`isCrossTraining(run)` (`src/types.ts`) is the one definition of the
running/not-running line for aggregates. Note it is NOT the same line as
`bestEfforts.ts`'s `NON_RUNNING_TYPES`, which also excludes `WALK` — walks have a
real distance and pace and still count towards volume.

### Where 0 km is already safe

Verified rather than assumed: `detectAnyRace` bails on `!run.km` (so a session on
race day can't auto-complete a race), `wholeRunEfforts` returns `{}` at `km<=0`,
`predictions.ts` filters `km>=3`/`km>=2`, `planStyles.recommendStyle` filters
`km>0`, `fmt.pace(0)` renders `--:--`, and `addRuns` coerces `Number(r.km)||0`.
Only the *presentation* needed fixing (below).

### Where it is deliberately excluded

- **Stats overview** (`StatsView`): everything except total *time* is
  running-only — distance, pace, elevation, both weekly charts, the pace trend,
  the run count and the average HR. Bike HR is real but not comparable, and a
  cross-training row that somehow carries a distance must not be able to claim
  "best pace". Time is the one honest common denominator, so it alone counts
  every session.
- **Plan auto-tick**: `findOpenPlanSession(plan, date, {crossTraining})` — the
  filter runs **both ways**. An indoor save passes `true` so it can only reach
  the cross-training day; the GPS tracker and the import-review toast pass
  `false` so a run can't tick off the bike session. A day can hold both.
- **Logging a plan session by hand**: `planSessionPrefill` (`utils/plan.ts`)
  drops the synthetic `km` for a cross-training row and prefills its prescribed
  minutes instead. `buildPlan` only gives those sessions a distance because the
  coach validator rejects `km <= 0`; prefilling it was the one live path by
  which a number nobody covered entered the log as running distance.
- **Row/detail rendering**: `RunRow` and `RunDetailModal` drop the distance and
  pace when `km` is 0. `--:--/km` claims a measurement that was never taken.

## The recorder (`src/modals/IndoorTracker.tsx`)

A separate screen, not a mode inside `LiveRunTracker`: with no GPS, that
screen's map, live sharing, route finder, guided workouts and
background-location disclosure all fall away, and branching 977 lines on
`indoor` would have left two half-features. What it *does* reuse is everything
that isn't location: `useRunTracker`, the two-key HR readiness derivation
(synced `hrMethod` **and** the per-device pairing/grant), `getHrSource` +
its `live` discriminant, `hrNudgeFor`, `useCountdown`, `useDismissable`.

Save goes through `persistImportedRoute` (`src/imports/persistRoutes.ts`) rather
than a second `saveRoute` call site: with no points it returns `hrRouteId`, the
exact shape a health-store import produces, so run detail's HR chart and
time-in-zone card work with nothing new built. Its offline trade-off applies
unchanged — the raw stream is dropped rather than queued, the avg/max still save.

`handleSave` resolves heart rate exactly the way `LiveRunTracker` does, and for
the same reasons. Keep the two in step — every rule in
`docs/health-integrations.md` about HR at save time applies here too:

- A live source has already filled `hrAvg`/`hrMax`; a **post-run** source is
  queried over `runWindow()` right there, and a store that hasn't synced yet
  gets an `hrPending` / `hrPendingHk` marker so `flushPendingHr` relinks it.
  Skipping that half is not a smaller feature, it is a broken promise — the
  screen tells those users heart rate arrives after they finish.
- The **native HR journal** is folded in first (`mergeHrSamples` +
  `readHrJournal`), live sources only. This matters *more* indoors than on a
  run: with no location service, backgrounding freezes JS immediately, so the
  journal is the only record of that stretch.
- The **coverage guard** applies unchanged: below `HR_MIN_COVERAGE` the session
  keeps its raw samples but claims no `hr`/`hrMax`, stamps `hrCoverage`, and
  toasts. On this screen heart rate *is* the session, so quoting a dropped
  strap's fragment would misreport the whole thing rather than one field of it.

Note the asymmetry in `useRunTracker`: the Android **fix** journal is
`indoor`-guarded (an indoor session records no fixes, and clearing it would
destroy a real run's unrecovered points), while the **HR** journal is not — an
indoor session streams the same strap and writes the same file, so it arms and
clears it exactly as a run does.

### `useRunTracker({ indoor: true })`

Switches off the geolocation half and nothing else. `startWatch` short-circuits
to `true`, the idle position preview, the permission check and the Android fix
journal are skipped, and the lock-screen notification effect returns early
(that notification is rendered *by* the location foreground service, which is
not running). The clock, wake lock, HR watch, pause/resume accounting and
`runWindow()` are untouched.

**The recovery buffer moves to `INDOOR_RUN_KEY`.** Two directions matter and
both are tested: an indoor session must never surface in the GPS resume offer or
the Dashboard's interrupted-run banner (it has no points to resume), and an
indoor `reset()`/`finalize()` must never wipe a real run's unrecovered buffer or
fix journal. `readRecoveryBuffer(key, {requirePoints})` carries defaults that
keep every pre-existing caller reading exactly the GPS buffer it always did.

## Live heart rate: what actually works where

Live bpm is **BLE-only and native-only** — `getHrSource` returns a `live:true`
source for `"bluetooth"` on Android/iOS and nothing else. Health Connect and
HealthKit are `live:false` (fetched post-run), and the web build has no HR path
at all. The screen is honest about it: a post-run source shows the "added after
you finish" line, no source shows "no heart-rate sensor set up", and neither
blocks recording — the duration is still worth having.

The zone readout is `LiveHrZone`, over `runZoneIndex` + `HR_ZONES` — the same
Karvonen maths and zone names as the settings editor and Progress, not a second
model. It renders nothing without a usable profile (no max HR, or a non-positive
reserve), mirroring `HRZonesCard`. `SESSION_ZONES.OTHER` states the Z2 aerobic
target explicitly rather than inheriting `sessionHR`'s unknown-type fallback:
base building is the point of these sessions.

## The screen has to stay on

With no location session there is no Android foreground service and no iOS
background execution, so the WebView's JS freezes the moment the app
backgrounds. **Be precise about what that does**, because the two halves behave
differently and the copy has to match:

- **The clock keeps counting.** `computeMoving` is wall-clock
  (`Date.now() - startRef`), so time spent with the screen locked lands in the
  duration when the app comes back. It does *not* pause.
- **Heart rate stops.** No JS means no sensor callbacks, so the locked stretch
  is simply missing from `hrSamples` — and therefore from the average, the max
  and the time-in-zone card.

`useRunTracker` still requests `navigator.wakeLock` (honoured in the Android
WebView and on iOS 16.4+, a no-op on the iOS 15.4 floor), and
`tracker.indoor.keepScreenOn` says exactly the above rather than claiming a
pause that never happens. The separate recovery buffer is what makes an
interruption survivable rather than fatal; the clock tick refreshes it every
`BUFFER_TICK_MS`, so a strapless session — which otherwise writes nothing at all
between Start and page-hide — can't lose its whole clock to a kill.

### The foreground service that holds the session

`AndroidManifest.xml` used to say BLE is "used only while a run is recording — the
GPS foreground service already holds the app then, so no extra HR foreground
service is declared." **An indoor session broke that assumption**: it runs no geo
watch, so nothing held the process, and a few minutes in the background was
enough for Android to reclaim the WebView renderer (below).

`IndoorSessionService` (+ `IndoorSessionPlugin`, seam at `src/indoor/session.ts`)
now holds it, started from `useRunTracker`'s `start`/`resume` and stopped on
`pause`/`stop`/`reset`/unmount — the same lifecycle as the HR journal, and armed
on the same condition:

- **Only with a live BLE strap streaming.** The service is declared
  `connectedDevice`, and that type is honest precisely because what has to
  survive backgrounding is the GATT link to the sensor; its prerequisite
  permissions (`BLUETOOTH_CONNECT`/`BLUETOOTH_SCAN`) were already held. `health`
  would have meant adding `ACTIVITY_RECOGNITION` or `BODY_SENSORS` — a new
  runtime prompt and a new Data Safety entry — to describe the same thing less
  accurately. **A strapless session therefore still has no service** and relies
  on the recovery buffer plus the renderer restart below.
- The notification's elapsed time is an **OS-rendered chronometer** anchored at
  the session start (`when` stays in the `System.currentTimeMillis` timebase, the
  same contract as the run notification's `chronometerStartMs`), so it ticks
  natively while JS is frozen. Copy is passed in from JS so it follows the app's
  language.
- Every native call is best-effort: a refused foreground start (no notification
  permission, or an Android 12+ background-start restriction) is logged and
  swallowed — recording continues exactly as it did before the service existed.

**Play Console:** the `connectedDevice` foreground-service type needs a
declaration in the console before a release with this can be rolled out.

### Surviving a killed renderer anyway

Android reclaims the WebView renderer of a backgrounded app under memory
pressure. The WebView then keeps painting its last frame — the recorder still on
screen, clock and heart rate frozen at their final values — while no JS runs at
all, so Pause and Finish do nothing. Read as "heart rate is stuck" before the
frozen clock gave it away.

The service above is the fix for a strapped session, but it can't cover
everything: a strapless session runs no service, and a foreground start can be
refused. So `MainActivity` also registers a `WebViewListener.onRenderProcessGone`
that returns true (returning false kills the process), destroys the dead WebView
and relaunches the activity — the app cold-boots and the recovery buffer offers
the session back. It **restarts at most once per
`RENDERER_RESTART_MIN_INTERVAL_MS` for a genuine crash** (`didCrash()`), so a
renderer that dies on every page load leaves a recoverable dead screen instead of
an inescapable boot loop; a reclaim, which is the case this is here for, never
repeats that fast.

`App.tsx`'s `subscribeStoreRefresh` guard ("never tear down a live recording")
checks **both** buffers. An indoor session is the more fragile of the two — no
fix journal, and no Dashboard banner to recover it from — so remounting the app
over one would simply lose it.

## Manual entry, and the rule that made it possible

`runFormComplete` requires a distance **except for `OTHER`**, which needs only a
duration. That one rule — not an indoor special case — is what makes a bike
session loggable by hand, with no tracker and no strap. `RunFields` shows the
machine picker and marks distance optional for `OTHER`, and it is shared with
`EditRunModal`, so editing a saved session works with no extra code.
`runFormToPatch` clears `activity` if the type moves off `OTHER`, so an edited
run can't keep claiming it was done on a bike.

## Deliberately not done

- **Importing indoor workouts** from Health Connect / HealthKit.
  `watch/mapping.ts` and `healthkit/mapping.ts` still map only running, walking
  and hiking and drop everything else. Admitting cycling would mean deduping
  against phone-recorded indoor sessions and deciding what a watch's cycling
  "distance" means — a separate piece of work.
- **Indoor sessions as `km:0` plan sessions.** The coach validator rejects
  `km<=0` (`validation.mjs`), which is why `buildPlan` gives cross-training days
  a synthetic km. Changing that is a validator change, not a recorder change.
- **Premium gating.** This is a recording surface, not new premium value.
