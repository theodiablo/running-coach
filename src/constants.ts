// Shared constants and presentational class strings used across the app.

// Keys for the cloud-backed per-user store (see src/db.ts).
export const STORAGE_KEYS = {
  RUNS: "rc_runs",
  PLAN: "rc_plan",
  SETTINGS: "rc_settings",
  // User-visible, editable context sent to the AI coach for future chats.
  USER_CONTEXT: "rc_user_context",
  // Personal races layer: wishlist / completed participations + seen-badge set.
  // The race *catalogue* is NOT here — it's shared/heavy (a bundled seed in
  // Phase 1, a Supabase table in Phase 2); only per-user data lives in the blob.
  RACES: "rc_races",
};

export const USER_CONTEXT_MAX_CHARS = 2000;
export const USER_CONTEXT_WARN_CHARS = 1600;
export const USER_CONTEXT_NOTICE_CHARS = 1800;

// localStorage key for the in-progress live run buffer (crash/refresh recovery).
// Kept out of STORAGE_KEYS on purpose: it must NOT sync to the Supabase blob —
// it's high-frequency local scratch space, flushed only on a real save.
export const LIVE_RUN_KEY = "rc_live_run";

// localStorage flag: the user has seen and accepted the background-location
// prominent disclosure (native shell only). Set once per install so we show it
// before the first OS permission prompt but don't nag on every run.
export const BG_LOC_DISCLOSED_KEY = "rc_bg_loc_disclosed";

// localStorage flag: we've asked once for the POST_NOTIFICATIONS runtime permission
// (Android 13+) so the foreground-service "recording run" notification can show.
// Once per install — asked the first time a run starts, never re-nagged.
export const REC_NOTIF_ASKED_KEY = "rc_rec_notif_asked";

// localStorage flag: we've asked once for ACCESS_BACKGROUND_LOCATION ("Allow all
// the time"). Only ever requested on a build that DECLARES the permission (the
// debug/personal sideload manifest — the public Play release never declares it),
// and only after foreground fine location is already granted. Once per install so
// a denied Settings round-trip never re-nags every run. See src/geo/background.ts.
export const BG_LOC_ASKED_KEY = "rc_bg_loc_asked";

// ── GPS tracking diagnostics (native) — PER-DEVICE, never in the synced blob ──
// A hidden developer log of the live tracker's fix stream, mirroring the watch
// sync log: it records each accepted/rejected GPS fix (with the reason), gap
// insertions, permission results, and app foreground/background transitions, so a
// screen-off run can be inspected to see exactly when and why fixes stop. Off by
// default (nothing recorded until the reveal flag is on); bounded ring buffer.
export const GEO_DIAG_LOG_KEY = "rc_geo_diag_log";   // JSON ring buffer of tracker events
export const GEO_DIAG_LOG_MAX = 2000;                // cap on stored events (FIFO)
export const GEO_DEBUG_KEY = "rc_geo_debug";         // "1" enables logging + reveals the panel

// ── Heart-rate sensor (native) — all PER-DEVICE, never in the synced blob ──
// The *method* preference (off/bluetooth/healthconnect) lives in synced settings
// (settings.hrMethod); the concrete paired device and one-shot UI flags are local
// because Bluetooth bonding is inherently per-device (a synced device id would
// show as "paired" on a phone where it isn't bonded). Mirrors the telemetry-
// consent / bg-disclosure decision to keep device-specific state out of the blob.
// One-time coach data notice — the AI coach can read detailed run data
// (splits/HR digests via get_run_detail). Per-device like the other one-shot
// disclosure flags: a fresh browser shows the notice again, which is the
// privacy-conservative direction.
export const COACH_DETAIL_NOTICE_KEY = "rc_coach_detail_notice_v1";

export const HR_DEVICE_KEY = "rc_hr_device";          // JSON {id,name} of the bonded BLE sensor
export const HR_BLE_DISCLOSED_KEY = "rc_hr_ble_disclosed"; // BLE permission disclosure seen
export const HR_HEALTH_CONNECT_AUTH_KEY = "rc_hr_healthconnect_auth"; // local HC permission was granted

// ── Watch run import (native) — PER-DEVICE, never in the synced blob ──
// Importing finished runs (distance/duration/elevation/HR) from a watch via
// Health Connect. The *preference* lives in synced settings.watchImport; these
// device-local keys mirror the HR reasoning: an Android Health Connect grant is
// per-install, so a synced preference alone must never touch the native bridge.
export const WATCH_HC_AUTH_KEY = "rc_watch_hc_auth";        // local exercise-read permission was granted
export const WATCH_SEEN_HC_IDS_KEY = "rc_watch_seen_hc_ids"; // JSON array of already-handled HC session ids
export const WATCH_SEEN_MAX = 200;                          // cap on the seen-ids list (FIFO)
// Developer diagnostics: a per-device ring buffer of recent import scans (what
// Health Connect returned and why each session was kept/dropped) plus the hidden
// reveal flag for the Settings sync-log panel. Dev-only, never synced.
export const WATCH_SCAN_LOG_KEY = "rc_watch_scan_log";     // JSON ring buffer of recent import scans
export const WATCH_SCAN_LOG_MAX = 25;                      // cap on stored scan-log entries (FIFO)
export const WATCH_DEBUG_KEY = "rc_watch_debug";           // "1" reveals the hidden sync-log diagnostics panel

// ── HealthKit (iOS) — PER-DEVICE, never in the synced blob ──
// One marker covers both HR reads and workout import (a single HealthKit
// authorization sheet grants both read scopes). Unlike Health Connect there is
// no trustworthy "is read granted?" probe (HealthKit hides read authorization),
// so this is set when the request flow completes and cleared only when
// HealthKit itself is unavailable — never from a permission check.
export const HK_AUTH_KEY = "rc_hk_auth";

// Canonical production web origin (no trailing slash). Native code that must
// name the web app's address uses this — e.g. Polar's OAuth redirect_uri, which
// is registered with Polar as the web origin and must match byte-for-byte even
// when the flow starts inside the Capacitor shell (whose own origin is
// capacitor://localhost and unreachable from a browser).
export const WEB_APP_ORIGIN = "https://run.camboulive.solutions";

// Public privacy policy (static page in public/privacy.html, served at the site
// root). Linked from the disclosure + login screen and required by the app stores
// for background-location apps.
export const PRIVACY_URL = WEB_APP_ORIGIN + "/privacy.html";

// Public health & safety / medical disclaimer (static page in public/disclaimer.html).
// Linked from the in-app onboarding disclaimer so the full version is reachable.
export const DISCLAIMER_URL = WEB_APP_ORIGIN + "/disclaimer.html";

// Version of the medical/liability disclaimer shown in onboarding. Stored
// alongside the user's acknowledgment (`settings.healthAck`) so a future change
// to the disclaimer copy can detect a stale acknowledgment and re-prompt. Bump
// this whenever the disclaimer wording materially changes.
export const DISCLAIMER_VERSION = "2026-06-1";

// Play Store listing — used by the in-app update prompt (see UpdatePrompt.jsx).
export const PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=solutions.camboulive.run";

// App Store listing for the iOS shell. Empty until the App Store Connect app
// record exists (Apple assigns the numeric id then) — fill in
// "https://apps.apple.com/app/id<APPLE_ID>" once known. While empty, the
// update prompt on iOS shows without a store button rather than dead-linking.
export const APP_STORE_URL = "";

// Closed test track for the Android app — the tester opt-in link,
// surfaced as a secondary CTA on the marketing landing while the app is in beta.
export const PLAY_STORE_BETA_URL =
  "https://play.google.com/apps/testing/solutions.camboulive.run";

// Public TestFlight opt-in for the iOS beta, surfaced on the marketing landing.
export const TESTFLIGHT_BETA_URL = "https://testflight.apple.com/join/T73yu15A";

// Tip jar (Buy Me a Coffee). Rendered ONLY inside the web-only marketing chunk
// (MarketingGate footer) — never in native surfaces: Apple rejects external
// payment links inside the iOS app. Empty string hides the link.
export const TIP_JAR_URL = "https://buymeacoffee.com/theo.camboulive";

// Map basemap. A keyed free-tier provider (MapTiler) — raw OSM tiles aren't
// allowed for a multi-user app under the OSMF tile policy. Set VITE_MAPTILER_KEY
// (a publishable, domain-restricted client key) at build. No default key is
// baked in: shipping a real key in a public repo lets anyone drain the owner's
// quota. Without the env var the tracker still records — RouteMap just shows a
// "needs key" notice instead of tiles. Attribution stays visible per the OSM
// data licence.
//
// Style is the built-in standard `streets-v2` slug. Built-in slugs ship
// pre-rendered raster tiles on every MapTiler plan (incl. free) and render with
// ANY valid key. Shared by every map surface (live tracker, run detail, history
// preview, race location picker) via this one constant.
//
// NOTE: a custom decluttered style (id 019f92a7-d9f3-7642-824f-18d8d0da7000)
// was tried here but reverted. Root cause, confirmed from an allowed origin
// with the production key: the style's vector `style.json` returns 200 but its
// raster `.../256/{z}/{x}/{y}.png` endpoint returns 403 — server-side RASTER
// rendering of a CUSTOM style is a paid-plan feature, while built-in slugs are
// pre-rendered for all tiers. It is NOT the URL, key, account, publish state,
// or Android. To use the custom style as raster: upgrade the MapTiler plan
// (then just set MAP_TILE_URL back to `.../maps/${id}/256/...`, zero other
// changes). To use it for free: render it as vector via MapLibre GL (a larger
// change, away from the CSP/WebView-safe Leaflet raster setup).
export const MAP_KEY = import.meta.env.VITE_MAPTILER_KEY || "";
export const MAP_TILE_URL =
  "https://api.maptiler.com/maps/streets-v2/256/{z}/{x}/{y}.png?key=" + MAP_KEY;
export const MAP_ATTRIBUTION =
  '© <a href="https://www.maptiler.com/copyright/">MapTiler</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';

// "Find a route" loop-suggestion feature gate (dormant by default, Polar
// pattern). Two independent gates both default off: this build-time flag
// (VITE_ROUTE_SUGGEST, a repo *variable* set to "1", threaded through the same
// workflow build steps as VITE_MAPTILER_KEY) AND a MapTiler key — without tiles
// a route drawn on a blank map is pointless, so the finder button doesn't render
// without both. The server has its own gate (route-suggest returns
// {configured:false} unless ORS_API_KEY is set), so the feature stays fully
// dormant until both client and server are configured.
export const routeSuggestEnabled = !!import.meta.env.VITE_ROUTE_SUGGEST && !!MAP_KEY;

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Per session-type text / border-background colour classes.
export const TCLR = {EASY:"text-emerald-400",TEMPO:"text-yellow-400",INTERVALS:"text-orange-400",LONG:"text-sky-400",RACE:"text-red-400",WALK:"text-cyan-400",OTHER:"text-violet-400"};
export const TBG  = {EASY:"border-emerald-500/30 bg-emerald-500/5",TEMPO:"border-yellow-500/30 bg-yellow-500/5",INTERVALS:"border-orange-500/30 bg-orange-500/5",LONG:"border-sky-500/30 bg-sky-500/5",RACE:"border-red-500/30 bg-red-500/5",WALK:"border-cyan-500/30 bg-cyan-500/5",OTHER:"border-violet-500/30 bg-violet-500/5"};

// Grade-adjust factor: each metre of climb counts as ~VERT_COST extra metres of
// flat running. Shared by the race predictions and the plan builder so the two
// agree on flat-equivalent distance. See flatEqKm in utils/predictions.js.
export const VERT_COST = 8;

// Shared Tailwind class strings for form controls, previously duplicated across
// several components.
export const INPUT_CLS = "w-full bg-slate-700 border border-slate-600 rounded-xl p-3 text-white text-sm focus:outline-none focus:border-orange-400 placeholder-slate-500";
export const LABEL_CLS = "block text-xs text-slate-400 mb-1.5";

// Colored accent bar per run type, shared by the dashboard and history list.
export const runBarColor = (type: string) => {
  if (type === "LONG")      return "bg-sky-400";
  if (type === "TEMPO")     return "bg-yellow-400";
  if (type === "INTERVALS") return "bg-orange-400";
  if (type === "RACE")      return "bg-red-400";
  if (type === "WALK")      return "bg-cyan-400";
  return "bg-emerald-400";
};
