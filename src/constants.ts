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
  // Completed stretching routines, for "already stretched today" and the weekly count.
  STRETCH_LOG: "rc_stretch_log",
};

export const USER_CONTEXT_MAX_CHARS = 2000;
export const USER_CONTEXT_WARN_CHARS = 1600;
export const USER_CONTEXT_NOTICE_CHARS = 1800;

// localStorage key for the in-progress live run buffer (crash/refresh recovery).
// Kept out of STORAGE_KEYS on purpose: it must NOT sync to the Supabase blob —
// it's high-frequency local scratch space, flushed only on a real save.
export const LIVE_RUN_KEY = "rc_live_run";

// The same buffer for an INDOOR session (no GPS — see docs/indoor-sessions.md),
// deliberately under its own key: an indoor session has no points, so it must
// never reach the GPS resume offer or the Dashboard's interrupted-run banner,
// and an indoor reset must never wipe a real run's recovery buffer.
export const INDOOR_RUN_KEY = "rc_indoor_run";

// Per-device memory of the last machine picked on the indoor screen, so the
// picker opens where the runner left it. Not a synced preference — it describes
// the gym they're standing in, not their account.
export const INDOOR_ACTIVITY_KEY = "rc_indoor_activity";

// Per-device memory of the finish-screen lines shown lately, so the next run
// draws something different. A convenience: losing it only allows a repeat.
export const CELEBRATION_RECENT_KEY = "rc_celebration_recent";

// How fresh the buffer must be to count as possibly still ON THE AIR: past it the
// publisher sweeps a leftover broadcast and the watcher stops treating the run as live.
// The recovery OFFER is not bound by it: interrupted data is never discarded for age.
export const RESUME_MAX_AGE_MS = 6 * 3600 * 1000;

// localStorage snapshot of the app_state cache while a cloud upsert is pending
// or has failed (offline save). Written before every flush attempt, cleared on
// a confirmed upsert, restored on the next boot when it is newer than the
// server row — so a run saved offline survives the process being killed.
export const UNSYNCED_STATE_KEY = "rc_unsynced_state";

// localStorage mirror of the last server-confirmed app_state blob (written on
// every successful load and flush). Boots the app offline when the cloud read
// fails at cold start; reconciled against the live row on reconnect (db.ts).
export const OFFLINE_STATE_KEY = "rc_offline_state";

// localStorage flag: the one-time Android battery-optimization nudge was shown
// (the OS killing the app mid-run is the #1 cause of lost recordings). Once per
// install, mirrors the other one-shot recording prompts above.
export const BATTERY_NUDGE_KEY = "rc_battery_nudge";

// localStorage flag: last "share this run" choice. Per-device, NOT synced: a synced
// "on" would put a run on the air from a device the user never armed. The ONE sharing
// switch (docs/live-sharing.md): on means readable at the standing link, and it also
// takes a run back off it.
export const LIVE_SHARE_KEY = "rc_live_share";

// localStorage marker: the `started_at` of a broadcast THIS device put on the air and
// has not confirmed deleted. The `live_runs` row is per-account, so without it the sweep
// can't tell "my own leftover" from "the run I'm watching" and would delete the latter.
// Set on first successful publish, cleared on a confirmed delete.
export const LIVE_PUBLISHED_KEY = "rc_live_published";

// localStorage: a CONFIRMED copy of the standing share link, {uid, token}, for offline
// render (src/live/shareLinkStore.ts). Never a token the ledger hasn't returned. Account
// data: sign-out clears it, and the uid stops the next account on a shared device seeing
// it. A NEW key on purpose: the v2 name holds spent per-run tokens that resolve to nothing.
export const LIVE_SHARE_LINK_KEY = "rc_live_share_link";


// localStorage: the WRITE capability for the current broadcast (the native uploader's
// auth while the WebView is frozen, src/live/publishToken.ts). Per-device, never
// displayed or synced; spent by endLiveRun / the sweeps. Survives an app kill so a
// recovered run keeps publishing under its row.
export const LIVE_PUBLISH_TOKEN_KEY = "rc_live_publish_token";

// localStorage flag: the user has seen and accepted the background-location
// prominent disclosure (native shell only). Set once per install so we show it
// before the first OS permission prompt but don't nag on every run.
export const BG_LOC_DISCLOSED_KEY = "rc_bg_loc_disclosed";

// localStorage flag: we've asked once for the POST_NOTIFICATIONS runtime permission
// (Android 13+) so the foreground-service "recording run" notification can show.
// Once per install — asked the first time a run starts, never re-nagged.
export const REC_NOTIF_ASKED_KEY = "rc_rec_notif_asked";

// localStorage flags for plan-session reminders (docs/reminders.md). The preference
// (settings.sessionReminders) is SYNCED; these are the per-device half: OS grant obtained
// on THIS install, and disclosure shown once. A synced preference never assumes a grant.
export const SESSION_NOTIF_AUTH_KEY = "rc_session_notif_auth";
export const SESSION_NOTIF_DISCLOSED_KEY = "rc_session_notif_disclosed";

// localStorage flag: asked once for ACCESS_BACKGROUND_LOCATION (declared in the main
// manifest), only after foreground fine location is granted. Once per
// install so a denied Settings round-trip never re-nags. See src/geo/background.ts.
export const BG_LOC_ASKED_KEY = "rc_bg_loc_asked";

// ── GPS tracking diagnostics (native) — PER-DEVICE, never in the synced blob ──
// Hidden developer log of the tracker's fix stream (accepted/rejected fixes with reason,
// gaps, permission results, app foreground/background) for inspecting screen-off runs.
// Off until the reveal flag is on; bounded ring buffer.
export const GEO_DIAG_LOG_KEY = "rc_geo_diag_log";   // JSON ring buffer of per-FIX rows (FIFO)
export const GEO_DIAG_LOG_MAX = 2000;                // cap on stored fix rows
export const RUN_DIAG_LOG_KEY = "rc_run_diag_log";   // everything else: run markers, HR, power
export const RUN_DIAG_LOG_MAX = 1500;                // cap on stored event rows (a reconnect storm writes ~1500/h)
export const DIAG_LOG_HEAD = 50;                     // oldest rows a full buffer never evicts
export const GEO_DEBUG_KEY = "rc_geo_debug";         // "1" enables logging + reveals the panel

// ── Heart-rate sensor (native) — all PER-DEVICE, never in the synced blob ──
// The *method* preference is synced (settings.hrMethod); the paired device and one-shot
// UI flags are local because BLE bonding is per-device.

// One-time coach data notice (the coach reads run digests). Per-device: a fresh browser
// shows it again, the privacy-conservative direction.
export const COACH_DETAIL_NOTICE_KEY = "rc_coach_detail_notice_v1";

export const HR_DEVICE_KEY = "rc_hr_device";          // JSON {id,name} of the bonded BLE sensor
export const HR_BLE_DISCLOSED_KEY = "rc_hr_ble_disclosed"; // BLE permission disclosure seen
export const HR_HEALTH_CONNECT_AUTH_KEY = "rc_hr_healthconnect_auth"; // local HC permission was granted

// ── Watch run import (native) — PER-DEVICE, never in the synced blob ──
// The *preference* is synced settings.watchImport; these keys are device-local because a
// Health Connect grant is per-install, so a synced preference alone must never touch the
// native bridge.
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
// One marker covers HR reads and workout import. HealthKit hides read authorization, so
// set when the request flow completes and cleared only when HealthKit is unavailable,
// never from a permission check.
export const HK_AUTH_KEY = "rc_hk_auth";

// Canonical production web origin (no trailing slash) for native code that must name the
// web app, e.g. Polar's OAuth redirect_uri, which is registered as the web origin and
// must match byte-for-byte even from the Capacitor shell (capacitor://localhost).
export const WEB_APP_ORIGIN = "https://run.camboulive.solutions";

// Public privacy policy (static page in public/privacy.html, served at the site
// root). Linked from the disclosure + login screen and required by the app stores
// for background-location apps.
export const PRIVACY_URL = WEB_APP_ORIGIN + "/privacy.html";

// Public health & safety / medical disclaimer (static page in public/disclaimer.html).
// Linked from the in-app onboarding disclaimer so the full version is reachable.
export const DISCLAIMER_URL = WEB_APP_ORIGIN + "/disclaimer.html";

// Mirrors `minimum_password_length` in supabase/config.toml. Sign-up and the
// Settings -> Account password form both validate against it so a rejection
// happens in the form rather than after a round trip; the server stays the
// authority (it also enforces password_requirements: lower + upper + digits).
export const PASSWORD_MIN_LENGTH = 12;

// Version of the medical/liability disclaimer shown in onboarding. Stored
// alongside the user's acknowledgment (`settings.healthAck`) so a future change
// to the disclaimer copy can detect a stale acknowledgment and re-prompt. Bump
// this whenever the disclaimer wording materially changes.
export const DISCLAIMER_VERSION = "2026-06-1";

// Play Store listing — the public production listing, used by the in-app update
// prompt (see UpdatePrompt.tsx) and by every "get the Android app" CTA.
// Per-device: the latest_version whose in-app update card was dismissed.
export const UPDATE_DISMISSED_KEY = "rc_update_dismissed";

export const PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=solutions.camboulive.run";

// App Store listing for the iOS shell. Empty until the App Store Connect app
// record exists (Apple assigns the numeric id then) — fill in
// "https://apps.apple.com/app/id<APPLE_ID>" once known. While empty, the
// update prompt on iOS shows without a store button rather than dead-linking.
export const APP_STORE_URL = "";

// Public TestFlight opt-in for the iOS beta, surfaced on the marketing landing.
export const TESTFLIGHT_BETA_URL = "https://testflight.apple.com/join/T73yu15A";

// Tip jar (Buy Me a Coffee). Rendered ONLY inside the web-only marketing chunk
// (MarketingGate footer) — never in native surfaces: Apple rejects external
// payment links inside the iOS app. Empty string hides the link.
export const TIP_JAR_URL = "https://buymeacoffee.com/theo.camboulive";

// Map basemap: MapTiler free tier (raw OSM tiles are barred for multi-user apps).
// VITE_MAPTILER_KEY is a publishable, domain-restricted key with no baked-in default;
// without it RouteMap shows a "needs key" notice. Built-in `streets-v2` slug on purpose:
// raster tiles for a CUSTOM style are a paid plan feature.
export const MAP_KEY = import.meta.env.VITE_MAPTILER_KEY || "";
export const MAP_TILE_URL =
  "https://api.maptiler.com/maps/streets-v2/256/{z}/{x}/{y}.png?key=" + MAP_KEY;
export const MAP_ATTRIBUTION =
  '© <a href="https://www.maptiler.com/copyright/">MapTiler</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';

// "Find a route" CAPABILITY gate (a MapTiler key is needed), NOT the access gate: access
// is profiles.premium_until, enforced by the route-suggest edge function (PREMIUM_REQUIRED).
// The server is inert until ORS_API_KEY is set ({configured:false}). No build-time flag:
// the tier is per-user server state.
export const routeSuggestEnabled = !!MAP_KEY;

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
  if (type === "OTHER")     return "bg-violet-400"; // matches TCLR.OTHER
  return "bg-emerald-400";
};
