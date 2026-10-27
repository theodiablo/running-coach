# Background location (Android)

Live run tracking needs GPS fixes to keep coming when the phone screen is off. The
foreground-service-only model (under the "while using the app" grant) left
minutes-long GPS holes on some devices once the WebView froze, so the app declares
and requests **`ACCESS_BACKGROUND_LOCATION`** ("Allow all the time") for all users.

## How it works in the app

- **Declared** in `android/app/src/main/AndroidManifest.xml` (alongside
  `ACCESS_FINE`/`COARSE_LOCATION`, `FOREGROUND_SERVICE_LOCATION`,
  `POST_NOTIFICATIONS`).
- **Requested in-context, never at launch.** When the user opens the run tracker
  and accepts the prominent `BgLocationDisclosure`, the app requests, in order:
  1. Foreground fine location (`ensureForegroundPermission`, precise).
  2. Background location (`ensureBackgroundLocationOnce` → `RunPermissions.requestBackgroundLocation`).
     On Android 11+ this routes to a Settings screen ("Allow all the time").
  3. `POST_NOTIFICATIONS` for the recording notification.
- **Asked once per install** (`BG_LOC_ASKED_KEY`); a denial never re-nags and
  **never blocks recording** — a run still records while the screen is on.
- **The one other request site is the race-day onboarding checklist**
  (`src/geo/readiness.ts`, `ReadinessChecklist`), an explicit tap per row ahead
  of race day. Its location AND "Allow all the time" rows show the same
  `BgLocationDisclosure` first unless this install already accepted it
  (`src/geo/disclosure.ts`, shared with the tracker); the background row is a
  deliberate re-ask, since the runner came there to fix it.
- The disclosure shows an explicit, bolded step-by-step walkthrough of those three
  prompts (`login.bgLocation.step1/2/3`), gated on `isBackgroundLocationAvailable()`
  so it only appears where the permission exists (Android, not web/iOS).
- The native `RunPermissions.checkBackgroundLocation` still reports `declared` and
  the request no-ops if the permission is ever absent from a build — defensive, so
  the path can't crash.

## Google Play status — already approved

The app **already has Google Play approval** for the location permissions it ships:

- `ACCESS_BACKGROUND_LOCATION`
- `ACCESS_COARSE_LOCATION`
- `ACCESS_FINE_LOCATION`

The background-location permissions declaration (core feature: screen-off run
tracking) is in place, and `public/privacy.html` explicitly covers background
location (a "Location data & background tracking" section plus a Permissions entry).
So shipping this permission is **not** a blocked/pending review item — no new Play
action is required to release it.

Only revisit the Play declarations if the location **use case materially changes**
(e.g. collecting location outside an active run, or 24/7 tracking) — that would
require re-declaring and could trigger a fresh review. Keep the in-app prominent
disclosure (`BgLocationDisclosure`) and the "only while a run is recording" scope
intact so the approved justification stays accurate. The `location` foreground
service type is declared in the manifest and covered by the same approval.

## Reverting / scoping down

If Play review is a problem, the safe fallback is to move the permission back to a
**debug-only manifest overlay** (`android/app/src/debug/AndroidManifest.xml`, a
single `<uses-permission>`): the manifest merger applies `src/debug/` to the debug
variant only, so it reaches sideload/CI-`apk` builds but never the release AAB, and
`isBackgroundLocationDeclared()` makes the whole request a no-op where it's absent.
That was the original personal-build-only approach (PR #115).

## iOS

iOS is unaffected by this change — there is no `ACCESS_BACKGROUND_LOCATION`
equivalent. Background tracking uses the `location` background mode in
`ios/App/App/Info.plist` (already present); `isBackgroundLocationAvailable()` is
false on iOS, so the Android-specific "Allow all the time" copy never shows there.
