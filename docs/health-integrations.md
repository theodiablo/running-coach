# Heart-rate sources & watch/file/cloud run imports

Native HR capture (BLE / Health Connect / HealthKit), phone-free watch run
import, and the import-provider registry (file + cloud imports). Moved out of
CLAUDE.md; keep this current when touching `src/hr/`, `src/watch/`,
`src/imports/`, or the health-store plugins. Polar specifics live in
`docs/integrations-polar.md`; the GPS-free indoor recorder that consumes the
live HR seam is in `docs/indoor-sessions.md`.

## HR sources (`src/hr/`)

**Same seam shape as GPS.** External HR capture mirrors `geoSource`:
`getHrSource` (`src/hr/source.ts`) returns a source or **null** (off / web /
unknown / wrong platform), so the web build is unaffected (HR capture is
native-only). Methods are platform-gated: `bluetooth` works on both shells,
`healthconnect` is Android-only, `healthkit` iOS-only — the Settings picker
renders the per-platform rows in `ConnectionsCard`, `getHrSource` resolves a
synced off-platform method to null, and `hrNudgeFor` (`src/utils/hrNudge.ts`)
keeps the other platform's setup prompt off screen. Two **narrow capability contracts**, not one fat interface — a source
carries a `live` flag:

- **Live** (`src/hr/ble.ts`, `bleSource`): a standard BLE Heart Rate Profile
  sensor (chest strap / armband / watch broadcasting, e.g. Amazfit "Heart Rate
  Push"). `isAvailable / scan / requestPermissions /
  watch(onSample,onErr,{deviceId}) / clearWatch`. `useRunTracker` streams it
  **alongside GPS**; samples are `{bpm,t}`, appended only while
  `state==="tracking"` (mirrors `onPos`), summarised by `hrSummary` into
  `stats.{hr,hrAvg,hrMax}`, and persisted in the `LIVE_RUN_KEY` recovery
  buffer. Parsing of the `0x2A37` characteristic is the pure, unit-tested
  `parseHrMeasurement` in `src/utils/hr.ts` (takes the plugin/Web-Bluetooth
  DataView). The watch opens **while the tracker is idle** — the HR analogue of
  the position preview, so the strap's bpm shows before Start and the run begins
  on an already-connected sensor — and is deliberately not torn down on the
  idle → tracking transition (`start`'s `startHrWatch` is then a no-op);
  `stop`/`reset`/unmount own the teardown. Pre-Start samples are display-only:
  they feed `stats.hr`/`stats.hrAt` via the `hrLast` state, never `hrSamples`,
  so `hrAvg`/`hrMax` stay strictly what the run recorded. `hr` and `hrAt` always
  come from the same sample — the lock-screen notification drops a reading it
  can't date. **Connection resilience** (the preview churns a connection per
  screen open/close, so the watch has to survive its own races): every attempt
  re-runs `initialize` (a failed first init must not wedge the watch);
  `clearWatch` teardowns chain and a new watch's first connect awaits the chain,
  so a closing watch's in-flight disconnect can never land on (and kill) a
  successor's fresh connection — the plugin serializes all calls through one
  global queue, which is what made that interleaving possible; a stopped watch
  whose connect resolves late only disconnects if no newer watch owns the
  sensor. After a failed direct connect the watch **re-discovers** the sensor
  with a short HR-filtered scan: Android can only connect to an unbonded
  peripheral it has recently seen advertise, and a sensor using resolvable
  private addresses invalidates the saved id when it rotates (pairing works,
  then "stuck connecting" forever) — the scan matches the saved *name* and a
  changed id is persisted via `onDeviceChange` → `setPairedDevice`.
  `useRunTracker` keeps the source object with the watch handle (teardown must
  reach the source that opened it, whatever `hrMethod` says now) and exposes
  `hrStatus` (`onStatus`: connecting / scanning / connected / unreachable);
  the record screen swaps "connecting…" for "can't reach sensor" once two full
  connect+scan cycles fail, while the watch keeps retrying with capped backoff.
  Three rules keep that retry loop from becoming the outage it is meant to fix
  (it was: runs came back with 5-15 minutes of HR out of 70, in bursts):
  **one attempt at a time** — the disconnect callback and a failed attempt each
  used to drive their own timer chain, which shared the backoff (so it hit the
  cap at once) and doubled the scan rate; **re-discovery has its own floor**
  (`SCAN_MIN_INTERVAL_MS`) because Android rate-limits an app to ~5 LE scan
  starts per 30s and silently returns nothing past that, so a per-attempt scan
  destroys exactly the mechanism it is running; and a **silence watchdog**
  (`STALL_MS`) tears the link down and reconnects, since a GATT link can sit
  nominally connected while notifications stop. The watchdog trusts itself only
  when it fires roughly on time (`STALL_GRACE_MS`): a frozen WebView stops its
  timers and its notification callbacks alike, so an overdue fire means "we were
  backgrounded", not "the sensor died" — acting on it would tear down a healthy
  link on resume, taking the native journal covering that stretch with it.

- **Post-run** (`src/hr/healthconnect.ts`, `healthConnectSource`): reads HR
  from Android Health Connect after the run via
  **@pianissimoproject/capacitor-health-connect**, dynamic-`import()`ed lazily
  (not a static top-level import) so merely rendering the app can't touch the
  native Health Connect bridge. Chosen over the Cap-8-native flomentum plugin
  because its `readRecords({type:'HeartRateSeries'})` reads **continuous** HR
  over an arbitrary window — so the user does NOT also have to log a workout on
  the watch. Trade-off: its peer is `@capacitor/core ^7`, resolved via the
  package.json `overrides` entry so a normal `npm install` picks up Cap 8
  (`--legacy-peer-deps` is deliberately avoided — it silently drops recharts'
  `react-is` peer). `useRunTracker` never streams it —
  `LiveRunTracker.handleSave` calls `fetchRange(start,end)` over the tracker's
  `startedAt`/`stoppedAt` window; on an empty result it stamps
  `hrPending:{start,end,source}` and `flushPendingHr` relinks on next load (the
  `flushPendingRoutes` deferred pattern), **never overwriting** an HR the user
  has since entered by hand. Pending HR markers are validated and expire after
  ~3 days; invalid/stale/manual-filled markers are cleared before touching the
  native bridge. Boot-time retries may query Health Connect only when both the
  synced method is `settings.hrMethod === "healthconnect"` **and** this device
  has the local authorization marker (`HR_HEALTH_CONNECT_AUTH_KEY`) from a
  prior grant; a synced method alone is not enough because Android permissions
  are per-install. Actual reads re-check permission and clear the marker if
  revoked. Needs `READ_HEART_RATE` + a Play health-data declaration/privacy
  policy.
- **HealthKit (iOS post-run, `src/hr/healthkit.ts` + `src/healthkit/`):** the
  iOS mirror of the Health Connect pair — `healthKitSource` (post-run HR
  fetchRange) plus a workout-import provider — backed by the local Swift plugin
  `HealthKitBridgePlugin` (raw values only; pure TS mapping in
  `src/healthkit/mapping.ts`, HK workout UUIDs ride `hcId` with an `hk:` prefix
  so the ONE dedupe rule set needs no changes). **Gotcha: HealthKit never
  reveals READ authorization** — there is no trustworthy checkPermissions; the
  per-device marker (`HK_AUTH_KEY`, `rc_hk_auth`, one marker for both HR and
  workouts — a single sheet grants both) is set when the request flow completes
  and cleared only on availability failure, never by a probe. Empty reads mean
  "no data", so runs just stay pending. **Pending markers are per-platform
  FIELDS:** Android stamps `run.hrPending`, iOS stamps `run.hrPendingHk` —
  separate because already-shipped Android builds clear any `hrPending` whose
  source isn't "healthconnect", so an iOS marker there would be destroyed
  through the synced blob. The shared engine `src/hr/pending.ts` triages one
  field per flusher (`flushPendingHr` / `flushPendingHkHr`, both called at
  RunningCoach's boot + foreground sites, whose patch clears both fields — a
  run only ever carries one marker); never move iOS markers back into
  `hrPending`. The HealthKit provider deliberately has NO `disconnect` — its
  auth marker is shared with post-run HR, so clearing it on watch-import "Turn
  off" would break `hrMethod:"healthkit"`. Per-workout HR aggregates in Swift
  use `HKQuery.predicateForObjects(from: workout)`, never a bare time window.
  Both health-store import providers share the synced `settings.watchImport`
  flag via `providerEnabledInSettings` (`src/imports/registry.ts`).

**Method preference syncs; the device does NOT.** `settings.hrMethod`
(`"off"|"bluetooth"|"healthconnect"|"healthkit"`) is in the synced blob; the
bonded BLE device `{id,name}` is **per-device localStorage** (`src/hr/device.ts`,
`HR_DEVICE_KEY`) — like the consent / bg-disclosure flags — because Bluetooth
bonding is per-phone. Treat the synced method as a preference only: before
using it, derive local readiness from the per-device state (`getPairedDevice()`
for Bluetooth, `hasHealthConnectAuthorization()` for Health Connect).
`LiveRunTracker` uses an effective method (`"off"` when the selected source is
not ready here) and prompts the user to pair/authorize in Settings before
Start, without blocking the run. BLE pairing reuses the disclosure→OS-prompt
pattern (`HrSensorDisclosure`, `HR_BLE_DISCLOSED_KEY`). A skippable nudge (in
`LiveRunTracker`) offers setup on run start while HR is off; it reappears each
run until the user sets HR up or taps "Don't record heart rate", which sets the
synced `settings.hrOptOut`. It never blocks Start.

HR lands in the **existing** run `hr`/`hrMax` fields (no shape change) via the
`LogView` prefill — still user-editable — so all HR display (`HRZonesCard`,
`runZoneIndex`, Stats) works unchanged.

**Coverage is the guard on every run-level HR claim.** A partial stream's mean
is the mean of the fragment that survived, not the run's heart rate — one run
was logged at 85bpm avg from its cooldown after the strap dropped at minute 15.
`hrCoverage` (`src/utils/hr.ts`) scores measured seconds against the run's
duration, capping each per-sample gap so a hole can't count as measured. The cap
**adapts to the stream's own cadence** (median gap × 3, floored at 10s): a BLE
strap notifies at ~1-2Hz and sits on the floor, but `stats.hrSamples` is also
written by the watch / HealthKit / GPX importers, whose series can legitimately
be one sample a minute — a fixed 10s cap scored a perfectly continuous import at
17% and called it a dropout. Below `HR_MIN_COVERAGE` `handleSave` stores the samples and the coverage but **no `hr`/`hrMax`**, and
toasts why. `RunDetailModal` re-derives coverage from the raw samples rather
than the stored field, so runs recorded before it existed are labelled too.

**The native HR journal** (`src/hr/hrJournal.ts` + the `bluetooth-le` patch) is
the HR twin of the GPS fix journal. A GATT notification callback runs in the app
process and keeps firing while the WebView is frozen, but `notifyListeners` only
reaches a running WebView — so those beats were lost. When armed, the patched
plugin appends `"<epochMs> <hex>"` per measurement to `run_hr_journal.jsonl`
(HR-measurement characteristic only); `handleSave` folds it into the live stream
with `mergeHrSamples` (±250ms dedupe — the same notification is stamped natively
and again on JS delivery). Its lifecycle mirrors `onHrSample`'s, not the
connection's: armed by `start`, **disarmed by `pause`** (the journal must observe the same breather the
live stream drops, or the merge folds a rest into the run), re-armed without
clearing by `resume` (arming is process state, so a crash loses it while the file
survives), disarmed by `stop`. Cleared by `reset`/`finalize`/`discardPrevious`
and by `start` — including when `start` finds no live watch to arm, since a
previous BLE run killed before it saved leaves beats on disk that must never
surface as someone else's heart rate. `handleSave` reads it only for a live
source, the same condition that armed it: a post-run source that inherited a
stale journal would both invent HR and, by producing an average, skip its own
store fetch. Android-only and best-effort: off Android, and on a shell built before the patch, it resolves
nothing and the JS stream stays the whole story.

## Connections UI (Settings)

Config UI is the unified **`ConnectionsCard`** (`src/views/ConnectionsCard.tsx`,
its own Settings card — it replaced the old `HrSensor` + `Integrations`
sections, which surfaced Health Connect twice): a BLE-sensor row, ONE
health-store row per platform (Health Connect / Apple Health) whose sub-toggles
write `hrMethod` and `watchImport`, registry-driven cloud rows (Polar), and on
web a single "in the mobile app" pointer (store links) instead of disabled
native rows — never render the OTHER mobile platform's store row. A fresh
health-store grant auto-enables watch import and — only when `hrMethod` is
`"off"` — post-run HR; it never silently replaces a configured method (BLE or
one synced from another device).

It lives on the **Integrations** sub-page (`src/modals/settings/`), below which
`VendorGuides.tsx` explains the vendors we cannot connect to (Strava, Zepp — see
below). **Integrations is also the home of file import**: recording (the FAB's
`RecordSheet`) never mentions it, because a file is account admin rather than a
way to record today's run. `IntegrationsPage` carries a top-level "Import a
file" card so it doesn't hide behind a collapsed vendor guide; the manual form
keeps one quiet link (`log.haveAFile`) as the sole entry point outside Settings. Each guide teaches the two paths we DO support, so "no integration"
never reads as "unsupported": export a file → the existing file importer (its
button calls `onImportFile`, which opens the importer screen), and vendor app →
platform health store → the connection above. The sync
copy is platform-branched (Health Connect / Apple Health / "use the mobile app"
on web). Adding a vendor is a `VENDORS` entry plus its i18n keys under
`settings.guides.<id>` in all three locales.

## Watch run import (phone-free runs)

For runners who leave the phone at home (e.g. Garmin Forerunner, Amazfit):
import a *finished* run's stats (distance, duration, elevation gain, avg/max
HR) after the fact, instead of live GPS. Native-only, opt-in
(`settings.watchImport`).

**Source is Health Connect exercise sessions, NOT the pinned HR plugin.** The
pianissimo plugin can only read `HeartRateSeries`, so this feature ships its
**own local Capacitor plugin**
(`android/app/src/main/java/solutions/camboulive/run/WatchImportPlugin.kt`,
registered in `MainActivity.java`) that reads `ExerciseSessionRecord`s +
aggregated `Distance`/`ElevationGained`/`HeartRate`/`ExerciseDuration`. The two
HC plugins coexist deliberately — don't merge them. The app module gets Kotlin
+ coroutines + `connect-client` (pinned to the pianissimo version).

**Gotcha — never put `kotlin-gradle-plugin` on the ROOT buildscript
classpath:** the root classpath is the parent classloader for every plugin
subproject, so a root KGP overrides the versions the Capacitor plugins resolve
for themselves (bluetooth-le needs 2.2.x for its `compilerOptions` DSL,
pianissimo builds with 1.8.x — a root pin broke one or the other in CI).
Instead the app module declares its **own** `buildscript` KGP (**2.2.20**,
matching bluetooth-le) in `android/app/build.gradle` and targets **JVM 21** via
`kotlin { compilerOptions { jvmTarget = JvmTarget.JVM_21 } }`, matching the
Java 21 the generated `capacitor.build.gradle` sets.

New `READ_EXERCISE`/`READ_DISTANCE`/`READ_ELEVATION_GAINED` manifest scopes
need a Play health-data declaration update before release. **Garmin → HC is
one-way, Android-14+, opt-in inside Garmin Connect, and carries NO GPS route**
— imported runs have no map (`routeId` stays absent, which the app tolerates).
They DO carry an HR series: `readHeartRateSeries` (`WatchImportPlugin.kt`)
reads `HeartRateRecord` samples over the session window, origin-filtered to the
writer, attached as `ImportedRun.hrSamples` by `scanWatchSessions` → the
HR-only `hrRouteId` sidecar (detail time-in-zone card). It reuses the
already-granted `HeartRateRecord` read permission, so it needs **no** new
manifest scope or Play re-declaration. Deliberately no route read on HC (no
writer provides `ExerciseRoute`; `READ_EXERCISE_ROUTES` would force a Play
re-declaration for data that doesn't exist — revisit if that changes).
HealthKit is the opposite: `readWorkoutDetail` (Swift) imports the Apple Watch
**route** (`HKWorkoutRoute`) AND per-sample HR for one workout (lazy, new
workouts only), so an Apple Watch run gets a full map + pace + HR chart.
Third-party watches on HealthKit still import totals only.

**Everything interpretable is pure TS** (`src/watch/`): `plugin.ts` (lazy
`registerPlugin` bridge, raw `WatchSessionRaw`), `mapping.ts`
(`sessionRunType`/`sessionLocalDate`/`sessionToRun`/`classifyWatchSessions`/
`newWatchSessions` — all unit-tested), `import.ts` (`scanWatchSessions` +
per-device auth/seen-id helpers). The native side returns **raw**
metres/seconds/exercise-type ints so the mapping stays testable off-device.
Per-session aggregates are filtered to the session's own `dataOrigin` so two
apps syncing the same run can't mix. **Fields the watch app doesn't write to
Health Connect stay blank, not zero** — `sessionToRun` only sets `elevation`
when `elevationGainM != null`, and HR (`hrAvg`/`hrMax`) is HC's own
BPM_AVG/BPM_MAX re-aggregated over the session window, which legitimately
differs by a few bpm from the source app's own displayed avg/max. Common
reality (seen with Zepp/Amazfit): distance + duration + HR import, **elevation
gain does not** — a genuine source-data gap, not a bug. `newWatchSessions` is a
thin filter over `classifyWatchSessions`, which labels **every** raw session
with an import outcome
(`imported`/`not-run-type`/`too-short`/`already-seen`/`duplicate`/`invalid`)
using the ONE dedupe rule set — the single source both the import and the
diagnostics log read from. Whether Zepp writes exercise *sessions with
distance* to HC (vs wellness only) is **unverified on-device**.

**Watch-import diagnostics (dev-only sync log):** every HC scan (including
skipped/failed ones) is recorded to a per-device ring buffer
(`src/watch/scanLog.ts`, `rc_watch_scan_log`, **never synced**, capped at
`WATCH_SCAN_LOG_MAX`) with per-session outcome + raw
type/distance/elevation/origin. `scanWatchSessions` takes a free-form `trigger`
label (`"auto"`/`"manual"`, threaded through `scanAllProviders` → provider
`scan` opts). The viewer is `src/views/WatchSyncLog.tsx`, **hidden** behind
tapping the Settings section title 5× (`rc_watch_debug`); a raw debug surface
(type ids, package names), deliberately **not** wired through i18n. Use it to
answer "my watch run didn't import" / "its elevation is blank": a `null`
elevation row means the watch app wrote none to HC. No Android rebuild is
needed for it — the native plugin already returns all sessions raw.

**Same two-key rule as HR:** `settings.watchImport` is a synced *preference*;
the real HC grant is per-install (`WATCH_HC_AUTH_KEY`, `rc_watch_hc_auth`) and
must be present before the native bridge is touched. `scanWatchSessions` copies
`flushPendingHr`'s guard structure (never throws, clears the marker on revoke).

**One Health Connect consent for both features.** HC permissions are per-*app*,
not per-plugin, so the post-run-HR reader (pianissimo, `HeartRateSeries`) and
the exercise-import plugin (`WatchImport`, Exercise/Distance/Elevation/HR)
share one OS grant. Both Settings entry points go through the single
coordinator `connectHealthConnect` (`src/health/connect.ts`): it asks for the
**full** scope set on one consent screen (via the WatchImport plugin, which
lists all four record types), then reconciles each feature's marker
independently (`healthConnectSource.checkPermissions` →
`HR_HEALTH_CONNECT_AUTH_KEY`, `watchImportSource.checkPermissions` →
`WATCH_HC_AUTH_KEY`) so a partial grant is reflected per feature. It returns
`{availability, heartRate, activity}`, never throws, and routes the
`NotInstalled` case through the pianissimo request (the only one that opens
Google Play for HC). Granting the OS permission does NOT flip a feature on —
each entry point still sets only its own preference (`hrMethod` /
`watchImport`); the other feature is then one tap from ready. Don't reintroduce
a scope-narrow per-button HC request — route new HC entry points through this
coordinator.

## Import-provider registry (`src/imports/`)

All import sources go through the provider registry: `types.ts` defines
`ImportProvider` (+ `ImportedRun` = `Partial<Run>` with transient route
`points` the *caller* persists via `saveRoute` and strips before `addRuns`);
`registry.ts` lists providers and `scanAllProviders` merges scans with
**cross-provider dedupe** so the same run from two sources collapses. Adding an
integration = implement the interface + register it; the toast/goLog/addRuns
pipeline needs no changes. Three providers:

- **healthConnect** — wraps `src/watch/`, deliberately brand-agnostic (one
  "Watch" entry for Garmin/Zepp/etc., brand stamped into run notes via
  `dataOrigin.ts`).
- **file** — CSV via `parseRunsCsv` + GPX/TCX via `src/utils/gpx.ts` + **FIT**
  via `src/utils/fit.ts`, works on web; GPX/TCX/FIT return route `points` →
  LogView saves them so imported files get maps. **FIT is binary**, so
  `LogView.handleFile` reads a `.fit` as an ArrayBuffer and passes `bytes` (not
  `text`) into the provider `parse`; `fit.ts` is a dependency-free decoder
  (like `gpx.ts`) that pulls `record` messages and reuses the shared
  `activityToRun` reducer so a FIT map/stats agree with a GPX one. FIT is the
  recommended full-fidelity path for Zepp runs (HC drops route/elevation):
  export the activity from Strava's "Export Original" (the .fit Zepp uploaded)
  or Export GPX — the in-app import help (`log.import.perActivity`) spells this
  out.
- **cloud** — vendor cloud APIs (OAuth + server-side pull). **Polar**
  (`providers/polar.ts`, the first real one — see
  `docs/integrations-polar.md`) works on **web AND native** and is **dormant
  until configured**: the secret half lives in the `polar-import` edge function
  + `integration_connections` table (service-role-only), and the provider's
  `isAvailable()` is false without `VITE_POLAR_CLIENT_ID` (wired into
  `deploy.yml`/`deploy-pr.yml` AND `release.yml`/`android-pr.yml`) — so it
  ships as a safe no-op, like `garminCloudProvider` (`providers/cloud.ts`,
  still scaffold-only). The edge function returns each exercise's raw **GPX**,
  parsed **client-side** by the app's existing `parseActivityFile`.
  `completePolarAuth()` (RunningCoach boot + the `rc-cloud-oauth-return` event)
  finishes the OAuth return, gated on a `state` marker so it never collides
  with Supabase's own `?code=` PKCE flow. **Native OAuth is a bounce**: Polar
  has ONE registered https redirect (the web origin), so a native connect marks
  its state `polar_import:native:<nonce>`, opens the system browser (Android
  via plain top-frame navigation / Bridge.launchIntent — never
  `@capacitor/browser` there; iOS via `Browser.open`), and the returning web
  page's `cloudOauthPreinit` forwards code+state to the
  `solutions.camboulive.run://polar-callback` deep link (scripted redirect +
  always-rendered tap fallback, since browsers gesture-gate custom-scheme
  navigation). `App.tsx` must route that deep link BEFORE its Supabase
  auth-code exchange (it also carries `?code=`); handshake values live in
  localStorage on native (sessionStorage dies with the killed app), and
  `completePolarAuth` only clears the stash when a code is actually consumed —
  wiping the nonce on a codeless boot would reject an in-flight return. The
  exchange passes the SAME https redirect_uri (`WEB_APP_ORIGIN`), never the
  WebView origin. All of that plumbing is provider-generic (`CLOUD_OAUTH` in
  `src/cloudOauthPreinit.ts` + `makeCloudOauth` in `src/imports/cloudOauth.ts`,
  with PKCE). **Suunto** (`providers/suunto.ts`, see
  `docs/integrations-suunto.md`) rides the same seam with a different sync
  shape: short-lived tokens (server-side refresh), **FIT** parsed client-side
  by `parseFitFile`, a server-held cursor + deferred ack (acked only after the
  runs are saved — `commitCloudScans` in the registry), full-history backfill
  on first connect, and `suunto-webhook` staging new workouts server-side.
  Credentials for every cloud provider live in the generic
  `integration_connections` table (service-role-only). COROS next: reuse this
  seam.

**Strava API is deliberately excluded**: its agreement bans AI-model use of API
data and the coach reads runs — users' own CSV/GPX exports are fine, that's
data portability, not the API. Polar's agreement has no such clause (the reason
it's the pilot). There is **no usable Zepp cloud API** for indies (official one
is corporate-partner only); password-based scraping libs are ToS-violating —
Amazfit rides Health Connect or files. Both are covered in-app by the
Settings → Integrations guides (`VendorGuides.tsx`) rather than by silence.

## The ONE dedupe rule set

`src/imports/dedupe.ts` `isDuplicateRun`, run-shaped — watch scans map sessions
first, then dedupe once; never add a parallel session-shaped check, the two
drifted before:

1. per-device seen-id list (`rc_watch_seen_hc_ids`, survives run deletion),
2. `hcId`/`extId` id-spaces,
3. `startedAt` time-overlap (GPS saves + timestamped CSV imports stamp
   `startedAt` too),
4. fuzzy same-date-±10%-distance for runs without a time window — auto-scans
   keep it (don't re-offer manually-logged runs), the file path disables it
   (`{fuzzy:false}` — never silently drop a user-picked row).

**No sync cursor** — a rolling 7-day window rescanned each trigger handles a
late watch sync (5-min auto-scan cooldown); manual 30-day scan in Settings.

## Wiring into the hub

`RunningCoach.scanImports` (via a latest-ref, called from the boot `[loading]`
effect + the `visibilitychange` listener, throttled to one auto-toast per
session) drives `scanAllProviders` → **1 run** goes through `goLog` prefill
(LogView review + `findOpenPlanSession` auto-tick + race auto-detect),
**several** land as an `addRuns` batch. `markSeen` runs inside `addRuns` for
any run carrying `hcId`. `shared.scanImportsNow` drives the manual 30-day scan.
Run gains `hcId`/`startedAt`/`extId` (`src/types.ts`); new provider
enable-flags go in `settings.imports` (HC keeps `watchImport`).
