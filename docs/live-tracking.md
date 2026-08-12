# Live run tracking (GPS) & the native shells

The GPS pipeline, route storage, run analytics, native permission flows, and
the Android/iOS shell build gotchas. Moved out of CLAUDE.md; keep this current
when touching tracking or the shells. Background-location policy detail is in
`docs/background-location.md`.

## GPS funnel & UI

- **Single GPS funnel:** `src/hooks/useRunTracker.ts` owns all geolocation
  (`watchPosition`), the start/pause/resume/stop state machine, moving-time
  accounting, wake lock, and a `localStorage` recovery buffer (`LIVE_RUN_KEY`,
  deliberately NOT synced to the app_state blob). Keep GPS access behind this
  hook so the source can swap without touching the UI.
- **UI:** `src/modals/LiveRunTracker.tsx` (full-screen, gated by `showTracker`
  in `RunningCoach`, opened via `shared.openTracker`). On finish it funnels
  into the normal save path — `goLog(prefill)` → `LogView` → `addRuns` —
  passing measured `durationSec`/`elevation` and the trace ref.

## Crash recovery (interrupted runs)

An OS-killed recording (battery optimization is the usual culprit — a real user
lost a run this way) is recovered from three layers; the shared read/normalize
logic is `src/utils/runRecovery.ts`:

- **The localStorage buffer** (`LIVE_RUN_KEY`, persisted by `useRunTracker` on
  every accepted fix) is **never expired silently** — an old buffer is still
  offered; `RESUME_MAX_AGE_MS` only bounds the live-sharing sweep/watcher.
  `normalizeRecovery` also closes the moving-time segment left open by the
  crash (`accSec` alone undercounts a never-paused run to 0:00).
- **The native fix journal** (Android): the patched plugin appends every fix
  its live renderer accepts to `run_fix_journal.jsonl` in app files, so points
  recorded after the WebView froze survive process death — JS can never have
  them in the buffer. Read via `getFixJournal` (`src/geo/fixJournal.ts`),
  merged by timestamp into the recovery offer on tracker mount; cleared on a
  fresh start and when the recovery is resolved (save/discard).
- **The Dashboard banner** (`RunningCoach` → `Dashboard`): a recoverable buffer
  is surfaced app-wide, not just inside the recorder — after a kill+relaunch
  the user lands on the dashboard and would otherwise never know. The tracker
  keeps sole ownership of resume/discard; the banner just opens it.

Related: the one-time **battery-optimization nudge** (`src/geo/battery.ts` +
`RunPermissionsPlugin.kt`) offers the OS exemption LIST screen while idle in
the tracker — deliberately not the direct request dialog, whose
`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` manifest permission is Play-restricted.
It never gates Start. Offline saves are covered separately: queued routes flush
on the `online` event too (`RunningCoach`), and the app_state blob snapshots
itself to localStorage around every upsert attempt (`src/db.ts`).

## Lock-screen live stats

**Nothing the runner reads with the screen off may depend on JS.** While
tracking, both shells show live distance/pace/HR plus a ticking duration on the
lock screen — Android in the foreground-service notification, iOS as a Live
Activity (lock screen + Dynamic Island). The duration is never pushed by JS:
background WebView JS is frozen and a stationary runner (`distanceFilter: 5`)
produces no GPS callbacks at all, so a JS-driven clock freezes exactly when the
feature matters. Instead both platforms self-render it from a shared anchor,
`chronometerStartMs = now - movingMs` (moving time, pauses excluded): Android
via a notification **chronometer** (`setUsesChronometer(true)`, patched plugin
— see the patches section below), iOS via `Text(_, style: .timer)`.

Data pushes ride the render pipeline through one `useRunTracker` effect on
`[state, stats]` → pure `buildRunNotificationContent`
(`src/utils/runNotification.ts`, i18n-free, returns a `titleKey`) →
`pushRunNotification` (`src/geo/liveNotification.ts`, the platform-routing
seam: content-gated with ~3s chronometer tolerance, retries until native
confirms `{updated: true}`, never throws, no-op on web). **Never wire
notification updates to the tracker's `setInterval`** — that timer is exactly
what stops in the background; the foreground 1s-tick effect re-runs are
no-op'd by the content gate. Pause is an explicit state push (chronometer off,
frozen time in the text). Stop: Android tears down with the watcher; iOS ends
its Live Activity via `resetRunNotification` (idempotent `cleared` flag; the
first reset after mount also sweeps a stale card left by a crashed session).

**On Android a JS push is a seed, not the update mechanism.** Android freezes
the WebView's task queues once the app is backgrounded, so *no* JS runs with the
screen off — not a throttled trickle, nothing: the bridge callback that delivers
a fix does not wake it. Recording is unaffected (the fixes queue natively and
land when the app comes back), but every JS-driven push stops, which is why the
notification used to sit unchanged for a whole run and only refresh on unlock.
So each push also carries `content.live` — `{km, paceSecPerKm, hr, hrAtMs,
tracking}` — and the patched plugin folds every subsequent fix into that
distance itself, re-posting the notification from the process that is still
running (`patches/`, section below). JS stays the authority: each push re-bases
`km`, so the number the runner sees when the screen comes back is the app's own.

**That native renderer mirrors the JS one and must stay in step.** Its gates are
`onPos`'s (accuracy ≤ 25m, ≥ 2s apart, move ≥ max(5m, accuracy/2), the 20m
warm-up floor), its distance is `haversineM`'s formula and radius, its pace is
the same 30s window as `stats.curPace`, and its text is
`buildRunNotificationContent`'s — same inputs, same string, so nothing jumps
when the app returns to the foreground. `useRunTracker.notification.test.ts`
pins the JS output for a known straight-line track; that literal is the
reference to check the Java against if either side changes. HR is the one thing
the service cannot recompute (the strap streams into JS), so a reading it can no
longer refresh is dropped after 90s rather than displayed stale.

iOS backend detail: the local `LiveActivityPlugin`
(`ios/App/App/LiveActivityPlugin.swift`, push/end, gated
`#available(iOS 16.2, *)` — the app deployment target stays 15.4, older
devices just don't get the card). The card UI lives in the widget extension
target `LiveActivityWidgetExtension` (`ios/App/LiveActivityWidget/`,
deployment target 16.2); `RunActivityAttributes.swift` is compiled into BOTH
the app and the extension (shared content-state contract — never fork it).
The widget's bundle id `solutions.camboulive.run.widgets` signs with its own
App Store profile — see `docs/release.md` → iOS signing.

## Route storage (`run_routes`)

**Traces are NOT in the blob.** The polyline lives in its own Supabase
`run_routes` table via `src/routes.ts` (direct queries, not `db`); a run only
stores a `routeId` reference. `deleteRun` cascades to `deleteRoute`;
backup/restore include routes. Offline saves queue in `localStorage` and relink
on next load via `flushPendingRoutes` (run carries a temp
`routeTmp`/`routePending`).

The `run_routes.stats` JSONB is a free-form sidecar: besides the summary
`{km,durationSec,elevation,avgPace}`, a run also stores its **raw ~1Hz HR
stream** there as `stats.hrSamples: {bpm,t}[]` (kept raw, NOT projected onto
GPS points, so HR fidelity is decoupled from `simplify()`'s point thinning).
Sources: a BLE-strap run (`LiveRunTracker.handleSave` from `rt.hrSamples`), a
HealthKit import (Apple Watch route + HR series), a Health Connect import (HR
series, no route), and file imports (GPX/TCX/FIT HR). All imports funnel
through `persistImportedRoute` (`src/imports/persistRoutes.ts`), which folds
`ImportedRun.hrSamples` into the sidecar; the two pure cleaners for raw native
payloads are `normalizeRoutePoints`/`normalizeHrSamples`
(`src/imports/series.ts`).

**A run with GPS points rides `routeId`; an HR-only sidecar (HR but no route —
the common Health Connect case) rides a SEPARATE `hrRouteId`** so History's map
button (gated on `routeId`) never offers a blank map, while `RunDetailModal`
still fetches it (`useRouteTrace` resolves `routeId ?? hrRouteId`) to draw the
HR chart + time-in-zone card (that card is NOT gated on GPS). `deleteRun`
cascades both; `LogView` prefill carries `hrRouteId`. Unknown JSONB key →
forward/backward safe, and backup/restore/pending-queue carry it free. To store
more per-run series later, extend this sidecar rather than widening the
4-tuple.

Because that stream can be hundreds of KB on a long run,
`getRoute(id, withStats)` / `useRouteTrace(run, {withStats})` gate the `stats`
fetch: map-only surfaces (History's route preview) pass `false`, only
`RunDetailModal` passes `true`. Keep new map-only consumers on
`withStats:false`.

## Per-run analytics (`src/modals/RunDetailModal.tsx`)

Tap a run in History or the Dashboard recent-runs list (`RunRow` has an
optional `onClick`; hub seam `shared.openRunDetail`, guarded on arg shape) →
full-screen map + a combined elevation/pace/HR `ComposedChart` (toggleable
series) + per-km split table + HR time-in-zone card + stat tiles. All
chart/table data is derived at render by **pure, tested helpers**:
`buildRunSeries` (`src/utils/runSeries.ts`, cumulative distance + smoothed pace
+ timestamp-aligned HR), `buildSplits` (`src/utils/runSplits.ts`), and
`timeInZones` (`src/utils/hr.ts`, reuses `runZoneIndex`/`HR_ZONES`). Both
series helpers share ONE gap-aware cumulative-distance walk, `flattenTrack`
(`src/utils/geo.ts`) — don't re-roll a third.

**Pace smoothing uses a rolling ~200m DISTANCE window, not a time window:**
stored points are Douglas-Peucker-thinned so they're sparse/uneven in time, and
a fixed time window left pace null (an intermittent line) on straight sparsely
sampled stretches. The trace is fetched via the shared `useRouteTrace` hook
(`src/hooks/`); the derived chart/table/zone data is `useMemo`'d on the trace
(the modal re-renders on unrelated hub state + every toggle click).

**Chart gotchas:** the distance x-axis MUST be `type="number"`
(post-`simplify` points are unevenly km-spaced; a categorical axis misplaces
them), and every series needs its own `yAxisId` matching a `<YAxis>` (recharts
errors otherwise) — both guarded by the render test in
`RunDetailModal.test.tsx`. HR series/cards render only when `stats.hrSamples`
is present (degrade gracefully otherwise).

**Chart↔map link:** the map passes `endpoints` (distinct start/finish markers,
replacing the live head dot) and a `highlight` point; hovering/tapping the
chart sets a `cursor` (a single nullable **index**, derived-during-render +
clamped to the trace), and `RunChart` (`memo`'d, with a stable `onCursor`)
reports recharts' `activeTooltipIndex`. **Gotcha:** recharts v3 hands that
index back as a STRING (`String(clampedIndex)`) for Line/Area/Composed charts,
so coerce it through `activeIndexFromChartState` (a `typeof === "number"` check
is always false → a permanently-null cursor). This works ONLY because
`buildRunSeries` and `flattenTrack` emit one row per real point in the same
order, so `series[i]` and `flat[i]` are the same point — an invariant locked by
a test in `RunDetailModal.test.tsx`. Use the index, never `activeLabel`
(float-matching the numeric axis). The exported `Readout` shows the highlighted
point's stats with a fixed min-height (no layout shift); `onPick` maps a map
tap back to the nearest `flat` point.

## Geo math

`src/utils/geo.ts` (haversine, jitter-gated `distanceKm`, hysteresis
`elevGainM`, Douglas–Peucker `simplify`, `segments`). A point is the tuple
`[lat, lng, tEpochMs, alt|null]`; a `null` entry is a GAP marker (don't bridge
it). Map basemap is MapTiler — needs `VITE_MAPTILER_KEY` (records fine without
it, just no tiles). The style is a custom map (`MAP_STYLE_ID` in
`src/constants.ts`) forked from `outdoor-v4` and decluttered for running;
edited at cloud.maptiler.com and shared by every map surface via that one
constant.

## `RouteMap` — the ONE shared map

`RouteMap` (`src/components/RouteMap.tsx`) is the one shared map component
(imperative Leaflet via refs, no react-leaflet, all markers inline SVG/CSS
divIcons — no PNG, CSP/native-WebView-safe). Additive props default inert so
History/LocationPicker are untouched: `endpoints`/`highlight`/`onPick` drive
the run-detail chart link (above). **Live nav-follow:** `follow` auto-centres
the head, but a user pan/zoom suspends it (`dragstart`/`zoomstart`, guarded
against our own `programmaticSetView` via a ref so a synchronous
`setView({animate:false})` isn't read as a gesture), reported via
`onFollowingChange`; bumping `recenterSignal` snaps back to the head at
`LIVE_DEFAULT_ZOOM` and re-arms follow. `LiveRunTracker` keeps the live map
`interactive`, shows a recenter FAB while `!following`, and bumps
`recenterSignal` on `visibilitychange`→visible (screen unlock / app
foreground) — the requested zoom reset on return from a locked screen. New
primitive-keyed effects (`[highlight?.lat, highlight?.lng]`,
`[recenterSignal]`) sit AFTER the track effect so they layer on top and never
fight the polyline redraw.

## Native background tracking (the `geoSource` seam)

Browser tracking is foreground-only (screen must stay on). True background
recording runs in the **Capacitor shells** (Android + iOS) that swap the GPS
source behind `useRunTracker`'s interface. The hook never touches
`navigator.geolocation` directly — it goes through `geoSource`
(`src/geo/source.ts`), which picks `webSource` (`src/geo/web.ts`,
`navigator.geolocation`, unchanged web behaviour) or `nativeSource`
(`src/geo/native.ts`: @capacitor-community/background-geolocation — Android
foreground service / iOS background location mode — for `background:true`,
@capacitor/geolocation for the idle preview). Selection is by `isNative`
(`src/native.ts` → `Capacitor.isNativePlatform()`), which also sets
`window.__NATIVE_SHELL__` for the UI; `platform`/`isAndroid`/`isIos` (same
module) gate platform-exclusive integrations (Health Connect vs HealthKit) — a
synced preference naming the other platform's integration must degrade to
"off" locally, never render its UI.

**One bundle serves all** web + shells; `isNative` is false in any browser, so
the web build is unchanged — keep it that way. To add a GPS source, implement
the `isAvailable / watchPosition(onPos,onErr,{background}) / clearWatch`
interface and hand `onPos` a
`{coords:{latitude,longitude,altitude,accuracy}, timestamp}` object (see
`adaptBgLocation`). Native auth uses a deep link (`AUTH_DEEP_LINK` in
`src/supabase.ts`, completed in `App.tsx`; Android intent filter +
`CFBundleURLTypes` in `ios/App/App/Info.plist`). Build: `npx cap sync
android|ios` then `.github/workflows/release.yml` (one `v*` tag ships both
stores); the web S3/CloudFront deploy stays untouched.

## iOS shell (`ios/`)

Capacitor 8 generated an **SPM** project (no CocoaPods) — `cap sync ios`
rewrites `ios/App/CapApp-SPM/Package.swift` and correctly excludes the
Android-only pianissimo Health Connect plugin (no `Package.swift`/ios dir). It
runs fine on Linux; only `xcodebuild` needs a Mac. Commit the Xcode workspace
`Package.resolved`. SwiftPM can retain an old background-geolocation manifest
by package identity after an npm upgrade; if it reports a Capacitor 7/8
constraint conflict, reset package caches or resolve with fresh DerivedData
rather than replacing Capacitor's generated package path.

App-local Swift plugins are NOT auto-registered: `MainViewController.swift`
(the storyboard's custom class) registers `HealthKitBridgePlugin` and
`LiveActivityPlugin` in `capacitorDidLoad()`. New Swift files must be
hand-added to `project.pbxproj` (build-file + file-ref + group + sources
phase); the project also carries a second native target,
`LiveActivityWidgetExtension` (WidgetKit appex embedded via the app target's
"Embed Foundation Extensions" phase, deployment target 16.2) — a file shared
with it (e.g. `RunActivityAttributes.swift`) needs a build-file entry in BOTH
Sources phases; `ios-pr.yml` (no-signing
Simulator build on PRs touching `ios/**`) is the compile check. Info.plist owns
the permission strings, `UIBackgroundModes` (`location`, `bluetooth-central`),
the deep-link scheme, and `ITSAppUsesNonExemptEncryption=false`;
`App.entitlements` carries the HealthKit capability.

## Android permission gotchas

- **The permission prompt silently no-ops when Location Services are off:**
  `@capacitor/geolocation`'s `checkPermissions()`/`requestPermissions()` are
  gated *by the plugin itself* on the device's system Location toggle — they
  **reject immediately if it's off, before ever showing the OS permission
  dialog**. `getCurrentPosition()`/`watchPosition()` aren't gated that way:
  they request the runtime permission themselves, then (via Google Play
  Services) surface the system "turn on device location" dialog if needed.
  `ensureForegroundPermission` (`src/geo/native.ts`) uses `checkPermissions()`
  only as a fast-path "already granted" check and falls back to a real
  `getCurrentPosition()` probe — the one call that can actually show both
  dialogs — whenever that check doesn't succeed.
- **Precise vs approximate location hinges on `enableHighAccuracy`.** On
  Android 12+ the plugin picks the runtime permission from
  `enableHighAccuracy`: `false` requests the COARSE-only alias, so the OS
  dialog never shows the "Precise" toggle and the user can only grant
  *Approximate*. Run tracking needs FINE GPS, so
  `ensureForegroundPermission(highAccuracy)` defaults to `true` and the
  run-tracking call sites pass `true`; only Discover's "races near me" one-off
  passes `false` (approximate is enough — don't over-ask). The fast-path
  "already granted" check is accuracy-aware (`isFineGranted` for a precise ask,
  `isGranted` for coarse) so a user who previously granted only Approximate is
  routed back through the probe to re-offer precise. A resolved probe still
  returns `true` even if the user picks Approximate — choosing it degrades
  accuracy, it never blocks the run.
- **Background location (`ACCESS_BACKGROUND_LOCATION`) ships to all users.**
  Screen-off recording via the foreground service alone left minutes-long GPS
  holes on some devices once the WebView froze, so the permission is declared
  in the **main** manifest and requested for everyone. The Play declaration is
  **already approved** and `public/privacy.html` covers it — but read
  `docs/background-location.md` before touching this: materially changing the
  location use case would need a fresh Play re-declaration. Request flow (all
  Android): the prominent `BgLocationDisclosure` (a Play requirement, shown
  before the OS prompt, dismissable via "Not now") →
  `nativeSource.requestPermissions` runs `ensureForegroundPermission(true)`
  FIRST, then `ensureBackgroundLocationOnce()` (`src/geo/background.ts`,
  Android-only, once per install via `BG_LOC_ASKED_KEY`) → then
  `POST_NOTIFICATIONS`. On Android 11+ the background grant is a **Settings
  round-trip** ("Allow all the time") that cannot appear in the first dialog —
  so the disclosure shows an explicit bolded 3-step walkthrough
  (`login.bgLocation.step1/2/3`), gated on `isBackgroundLocationAvailable()`.
  A declined background grant **never blocks the run**.
  `RunPermissionsPlugin.kt`'s background-location methods keep the
  `isBackgroundLocationDeclared()` guard as defensive code.
- **`POST_NOTIFICATIONS` (Android 13+) is requested by the local
  `RunPermissions` plugin** (`android/.../RunPermissionsPlugin.kt`, registered
  in `MainActivity.java`), because neither geolocation plugin requests it and
  without it the foreground service's ongoing "recording run" notification is
  silently suppressed (the service still runs — recording is never blocked).
  The JS seam is `src/geo/notifications.ts`:
  `requestRunNotificationsOnce()` asks once per install (`REC_NOTIF_ASKED_KEY`)
  the first time a run starts — wired into `LiveRunTracker`'s `guardedStart` +
  `acceptDisclosure`, before the service starts. Below Android 13 it's a no-op.
- **Every native Start/Resume is gated on a live location check**
  (`guardedStart` in `LiveRunTracker`): after the disclosure, it `await`s
  `rt.requestPermissions()` (→ `ensureForegroundPermission`) and aborts if it
  returns false, so a run never enters the "tracking" state with a running
  clock and a blank map. That one call covers BOTH failure causes — permission
  not granted (OS prompt) and Location Services off (the `getCurrentPosition`
  probe surfaces the "turn on location" dialog) — and on denial sets
  `tracker.errors.permissionDeniedNative`. For a granted user with location on
  it fast-paths (a bare `checkPermissions()`, no dialog), so it's not a per-run
  nag. Don't drop this gate back to "start and hope" — the silent blank-map run
  was the bug.

## GPS tracking diagnostics (dev-only, native)

A hidden per-device ring buffer (`src/geo/trackLog.ts`, `GEO_DIAG_LOG_KEY`,
**never synced**, capped at `GEO_DIAG_LOG_MAX`) records the live tracker's
event stream — each raw `native-fix` arrival at the JS boundary, whether it was
kept (`fix`) or dropped (`drop`, with reason) or opened a `gap`, plus
permission/watch/foreground-background transitions. Instrumented in
`useRunTracker.ts` and `geo/native.ts`. Logging is a **no-op until enabled**
(`isGeoDebugEnabled`, cached in-module so the per-fix cost is nil when off).
Viewer is `src/views/TrackDiagLog.tsx` — revealed by the SAME Settings →
Connections title 5-tap as the watch sync log (`revealTap` flips `setGeoDebug`
too); its summary reports max fix-gap **while hidden vs visible**, the direct
read on "do fixes stop when the screen is off". Raw + English-only (a debug
surface, not wired through i18n), mirroring `WatchSyncLog`.

## npm dependency patches (`patches/`)

Applied by `postinstall` → `patch-package`; native plugin modules compile
straight out of `node_modules` (`android/capacitor.settings.gradle`), so a
committed patch reaches every local and CI build. Three packages are patched.

### `@capacitor-community/bluetooth-le` (HR journal)

Adds `setHrJournal` / `getHrJournal` / `clearHrJournal` and, in
`startNotifications`' notify callback, one line that appends a Heart Rate
Measurement to `run_hr_journal.jsonl` before it reaches the bridge. The reason
is the same one behind the fix journal above: the GATT callback keeps firing
while the WebView is frozen, but `notifyListeners` reaches nothing, so a
backgrounded run recorded no heart rate at all. Guarded on an armed flag and on
the `0x2A37` characteristic, so nothing else in the app is ever journalled, and
wrapped so a write failure can never cost the sample itself. Consumed by
`src/hr/hrJournal.ts` — `docs/health-integrations.md`.

### `mdast-util-gfm-autolink-literal` (iOS 15 regex lookbehind)

Pulled in by `remark-gfm`, which renders the coach's markdown replies. It
shipped its bare-email autolink regex with a **lookbehind**
(`(?<=` …), which **iOS < 16.4 JavaScriptCore cannot parse** — Safari only
shipped lookbehind in 16.4, and our deployment target is 15.4. A lookbehind is
fatal at *parse* time, not match time, so the entire `CoachChat` chunk failed to
load with `SyntaxError: Invalid regular expression: invalid group specifier
name`. Because `RunningCoach` warms that chunk with a bare `import()` right
after sign-in, an iPhone on iOS 15 hit the app-wide crash overlay the moment it
signed in — reported as "Google login crashes". The patch deletes the
lookbehind; `findEmail` already re-checks the preceding character in JS
(`previous(match, true)`, whose `index === 0 || unicodeWhitespace ||
unicodePunctuation` test covers exactly `^ | \s | \p{P} | \p{S}`, since
micromark defines `unicodePunctuation` as `/\p{P}|\p{S}/u`), so autolinking is
unchanged — pinned by `src/coachMarkdown.test.tsx`.

**The general rule: no regex lookbehind may reach the bundle.** It only ever
arrives through a dependency, so `scripts/check-bundle-regex.mjs` scans the
build output and fails `npm run build` (and therefore CI, which now builds).
Lookahead, named groups and `\p{…}` escapes are all fine on iOS 15 — lookbehind
is the lone gap.

## The iOS 15.4 compatibility floor

Three separate things have to agree, and only the first is enforced by the
compiler:

1. **Syntax — `build.target` in `vite.config.ts`.** WKWebView's JS engine *is*
   the OS version, so an iPhone on iOS 15 runs a Safari 15 engine no matter how
   current the app is. Vite's default target is `baseline-widely-available`,
   which resolves to **ios16.4** — it was emitting class static blocks, which
   iOS 15 cannot parse. The target now pins `safari15.4`/`ios15.4` (the other
   three legs keep the baseline, since one bundle serves web too), and
   `src/iosCompat.test.ts` fails CI if it ever drifts past
   `IPHONEOS_DEPLOYMENT_TARGET`. Raise both together, never just one.
2. **Regex — `scripts/check-bundle-regex.mjs`.** Setting the target does *not*
   help here: the bundler leaves an unsupported regex literal exactly as it
   found it, no error and no warning (verified). Hence the separate scan.
3. **Runtime APIs — neither of the above.** A target lowers syntax; it never
   polyfills a method. `Object.hasOwn` and `structuredClone` (both Safari
   **15.4**) reach the bundle via `es-toolkit`, pulled in by `recharts` for the
   Progress charts, and would throw on iOS 15.0–15.3. **This is why the floor is
   15.4, not 15.0** — the alternative was polyfilling for every user, and a
   correct `structuredClone` is not cheap. The band it drops was 0.21% of iOS
   devices worldwide (~1 in 480, and 9.6% of iOS 15 itself; ~90% of iOS 15 was
   already on 15.4+, since Apple still ships 15.8.x security updates to the
   iPhone 6s/7/SE1 generation that is stuck there), lower again in Europe, on
   2015–2016 hardware that struggles with GPS tracking anyway.

   Nothing enforces this leg, so it stays a review question: **an API newer than
   the floor is invisible to both the target and the regex scan.** If a
   dependency ever pulls in one that matters, either polyfill at the `main.tsx`
   entry or raise the floor again — and if you raise it, raise `build.target`
   with it.

### `@capacitor-community/background-geolocation`

Five independent changes.
(1) Lifecycle NPE fix: it crashed in production ("Unable to pause activity" →
NPE at `Bridge.getPermissionStates`, Bridge.java:1217) because its
`handleOnPause`/`handleOnResume` call `getPermissionState("location")` — the
annotation-reflection path — on every activity pause/resume; the patch computes
the same both-granted COARSE+FINE check via
`ActivityCompat.checkSelfPermission` in a try/catch instead.
(2) Lock-screen live run stats: an `updateNotification({title, message,
chronometerStartMs?, km?, paceSecPerKm?, hr?, hrAtMs?, tracking?})` plugin
method (upstream has no post-start notification API) that rebuilds the
foreground-service notification (extracted `buildNotification` helper;
`VISIBILITY_PUBLIC`, `setOnlyAlertOnce`, optional OS-rendered chronometer) and
re-posts it via the service binder with the same NOTIFICATION_ID, resolving
`{updated}` so a push that raced ahead of `addWatcher` gets retried by the JS
seam (`src/geo/liveNotification.ts`). The `km`/`pace`/`hr`/`tracking` fields
seed the patch's own renderer (`seedLiveStats` / `onLiveLocation`), which folds
each incoming fix into the distance and re-posts without JS — see the
lock-screen section above for why that has to be native.
(3) Fix journal: every fix that live renderer accepts is also appended to
`run_fix_journal.jsonl` (app files dir, size-capped, best-effort), with
`getFixJournal`/`clearFixJournal` plugin methods — the crash-recovery layer
that survives process death (see *Crash recovery* above). Lines parse
individually so a torn last write costs one point, not the file.
(4) `LIVE_FIX` relay: every accepted fix is ALSO re-broadcast on the app-owned
LocalBroadcast action `solutions.camboulive.run.LIVE_FIX` with the fold's own
derived numbers (km, durationSec, curPace, gap flag), consumed by the
app-local `LivePublishPlugin.kt` for screen-off live-share uploads
(`docs/live-sharing.md`). One native fold, three consumers — never duplicate
the acceptance gates. The action string is duplicated in the Kotlin plugin;
keep them in step.
(5) The native fold runs BEFORE the saved-call lookup in `ServiceReceiver`,
not just before the bridge hop: a WebView reload releases saved calls while
the service keeps broadcasting, and gating on the call silently froze the
notification, the journal and the relay for the rest of the run. The receiver
is also held in a field and unregistered in `handleOnDestroy` — the manager is
application-scoped, so a destroyed instance's receiver would otherwise survive
activity recreation and double-fold every fix.
Numbers cross the
bridge as JSON, so **read them with the patch's `optNumber`, never
`PluginCall.getDouble`**: `getDouble` only unwraps Double/Float/Integer, and any
epoch-ms value arrives as a `Long` — which is how `chronometerStartMs` was
silently dropped (no ticking clock) until this was found. The
dependency is **pinned exact** (no `^`) so the patch always matches; on a
version bump, check whether upstream fixed the lifecycle permission check (repo
issue tracker was silent as of 1.2.26 and the plugin lags on Capacitor majors —
see its issue #156), then regenerate
(`npx patch-package @capacitor-community/background-geolocation`) or delete the
patch.

## Android release builds & R8

`android/app/build.gradle` keeps `minifyEnabled true`, `shrinkResources true`,
and the optimized default ProGuard file for `release`. Capacitor's consumer
rules preserve annotated plugin entrypoints (the classes), but **not the
`com.getcapacitor` annotation classes themselves** — and AGP 8's default R8
*full mode* strips runtime annotation data unless the annotation class is kept,
which broke Capacitor's reflection-based permission machinery in production
(NPE at `Bridge.getPermissionStates`, hit both by background-geolocation's
lifecycle hooks — the `patches/` workaround — and by
`Geolocation.checkPermissions()`/`watchPosition()` when the live tracker
opens). Fix is two-layer: `android/app/proguard-rules.pro` keeps the Capacitor
annotation classes + runtime-annotation attributes, and
`android/gradle.properties` sets `android.enableR8.fullMode=false` as a safety
net (removable only after the full tracker flow is verified on-device on a
full-mode build). Add further narrow library-specific keep rules only when a
release build or on-device test demonstrates a reflection requirement (checked:
the ION geolocation AAR that @capacitor/geolocation 7+ wraps ships no consumer
rules but does no reflection). Debug builds stay unminified; `android-pr.yml`
also runs `bundleRelease` so PR CI compiles R8 — but a green build does NOT
prove runtime correctness: R8 stripping a reflectively-used class/method still
builds successfully and only crashes on-device, so validate release behaviour
on a device before shipping. Because the release AAB is obfuscated,
`release.yml` uploads the per-build R8 `mapping.txt` (artifact
`running-coach-mapping-<code>`) — it's the only way to deobfuscate native crash
stacks (PostHog `captureError`) and is regenerated each build, so never rely on
it surviving elsewhere.
