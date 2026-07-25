# Telemetry (analytics + crash reporting)

Telemetry is **vendor-agnostic at the call sites and off by the time it reaches
the network**. The app only ever talks to one seam, `src/telemetry/index.ts`;
the vendor lives behind it in a single adapter (`src/telemetry/posthog.ts`, the
only file that imports an SDK). Swapping vendors means replacing that adapter and
nothing else.

The provider is **PostHog** (product analytics *and* error tracking in one SDK).
It is **off until keyed**: without `VITE_POSTHOG_KEY` the adapter reports itself
unconfigured and the whole module is a no-op — and `posthog-js` is a dynamic
import, so it isn't even fetched until telemetry activates at runtime (it stays
out of the main bundle and out of any keyless build).

## Configuration

Set at build time (e.g. `.env.local`), same pattern as `VITE_MAPTILER_KEY`:

| Env var              | Required | Default                       | Notes |
| -------------------- | -------- | ----------------------------- | ----- |
| `VITE_POSTHOG_KEY`   | yes      | — (telemetry off without it)  | PostHog **project API key** (public, client-side). |
| `VITE_POSTHOG_HOST`  | no       | `https://eu.i.posthog.com`    | EU Cloud by default (privacy hosting). Use `https://us.i.posthog.com` or a self-host URL to change region. |
| `VITE_APP_ENV`       | no       | `development`                 | Tags every event + crash with an `environment` super property. The deploy workflows set `production`; the PR-preview workflows set `preview`; unset (local builds) is `development`. |

The PostHog SDK is initialised with **pageviews and pageleaves ON** — the
standard web-analytics events that drive visitor/session counts and PostHog's
**Web Analytics** tab. Both are part of the core bundle (no remote fetch), so
they satisfy our CSP and also fire inside the native WebView (one `$pageview`
per app open — there's no router). Alongside them the app still sends its small
curated set of explicit events (`run_logged`, `plan_generated`, …).

Three capture features are deliberately **off**, each for a concrete reason —
don't flip them without reading this:

- **`autocapture`** — records the visible text of clicked elements (`$el_text`),
  which in this app can include race names and run details. That's exactly the
  free text the telemetry policy never sends, so autocapture stays off. (If you
  ever need it, strip text via `sanitize_properties` first.)
- **`capture_exceptions`** (PostHog's *automatic* exception capture) — lazy-loads
  `exception-autocapture.js` from PostHog's asset host, which
  `disable_external_dependency_loading` + our CSP (`script-src 'self'`) block, so
  it would silently never load. Crashes are captured with the **bundled**
  `captureException` API instead (see *Crash reporting* below).
- **`disable_session_recording: true`** — the recorder is another remote bundle
  blocked by the same CSP, and recording sessions is a much larger privacy
  surface. Enabling it would need a `script-src` relaxation and a fresh consent
  review.

`person_profiles: 'identified_only'` (anonymous events don't create Person
profiles — count unique users by `distinct_id` instead).

Every event (and every crash) carries two super properties: `environment`
(above) and `native` (true in the Capacitor shell). **PR previews send to the
same PostHog project as production** — filter on `environment = 'production'` in
your insights to exclude preview/local noise. Vite's own `MODE` can't tell
production from preview (both are a `vite build`), which is why `VITE_APP_ENV` is
an explicit var.

**Two gotchas if events don't arrive:**

- **CSP.** PostHog's host is allow-listed in `connect-src` in `index.html`
  (`https://*.i.posthog.com`, covering EU + US). Without it the browser / Android
  WebView silently blocks every request and you'll see nothing. We also set
  `disable_external_dependency_loading: true` so PostHog never injects remote
  `<script>`s, keeping `script-src 'self'`. If you point `VITE_POSTHOG_HOST` at a
  self-hosted/custom domain, add it to `connect-src` too.
- **Region must match the key.** The default host is **EU** (`eu.i.posthog.com`).
  A **US** project's key only works against `https://us.i.posthog.com` — set
  `VITE_POSTHOG_HOST` accordingly. The `*.i.posthog.com` CSP already allows both.

## Consent model

- **Opt-in (EU/ePrivacy).** Telemetry collects **nothing** until the user accepts
  via the first-run **`ConsentBanner`** (`src/components/ConsentBanner.tsx`),
  shown over both the login screen and the app. Until then the SDK never inits,
  so no cookie / `localStorage` entry is written on the user's behalf. The choice
  is changeable any time in **Settings → Privacy**.
- **Consent is per-device.** The single source of truth is `localStorage`
  (`rc_telemetry_consent_v2` — rotated from `rc_telemetry_consent`, which the old
  opt-out build auto-populated), tri-state: `"1"` granted, `"0"` denied, **absent =
  undecided** (banner not answered → reads as not consented). It is deliberately
  *not* in the synced app_state blob: consent to store data on a device is
  inherently per-device, so a fresh browser should ask again. `getConsent()`
  returns true only for `"1"`; `getConsentDecision()` exposes the tri-state for
  the banner's visibility.
- **Crashes are auto-reported on both platforms, consent-gated.** A crash — a
  React render error, or an uncaught window `error` / `unhandledrejection` — is
  captured via the bundled `captureException` whenever the user has granted
  analytics consent, and never otherwise. The rule is identical on web and
  native. The `ErrorBoundary` still shows a friendly crash screen (reload +
  copy/email-trace escape hatch); it no longer asks *per crash* whether to send
  (that native-only "Send report" prompt was removed when native moved to
  auto-report). PostHog's *automatic* exception capture stays off (blocked by our
  CSP — see above), so crashes ride our own handlers, not the remote bundle.
- `track()` / `identifyUser()` are gated on consent. `captureError()` is not —
  its call sites are (the `ErrorBoundary` and the web global handlers report only
  when `getConsent()`). Keep that split when extending.

## What's wired today

- `initTelemetry()` / `installGlobalErrorHandlers()` — `src/main.tsx`.
- `ErrorBoundary` around `<App/>` — `src/main.tsx` / `src/components/ErrorBoundary.tsx`.
- First-run opt-in `ConsentBanner` + `identifyUser` / `resetUser` on auth —
  `src/App.tsx`.
- Events (`onboarding_completed`, `run_logged`, `plan_generated`,
  `race_target_set`, `race_completed` `{source:"manual"|"auto"}`,
  `plan_race_added` — a secondary race folded into the plan) —
  `src/RunningCoach.tsx`. Limited: counts/enums only, never race
  names/notes/times. `plan_race_added` carries no properties (there is no race
  priority/tier). **`run_logged` `{count, source}` is the "new run tracked"
  signal** — `source` is `"gps"` for a live-tracked run, `"manual"` for a
  hand-logged one, or the import provider — so filter `source = 'gps'` for runs
  recorded with live tracking.
- `live_run_started` `{}` — fired the moment a live GPS tracking session
  actually begins (after the disclosure / permission / HR gates and the
  countdown, never on Resume) — `src/modals/LiveRunTracker.tsx`. Pairs with
  `run_logged {source:"gps"}` as a start→save funnel.
- Coach agent events: `coach_opened`
  `{source:"header"|"dashboard"|"plan_session"|"settings"|"other"}` when the
  chat is opened, fired in the hub's one `openCoach` seam
  (`src/RunningCoach.tsx`) so every entry point is counted the same way — it's
  how the header button's pull is compared against the dashboard card and the
  per-session "Ask coach". Pairs with `coach_message_sent` as an
  open→first-message funnel (an open with no message is an abandoned chat).
  `coach_message_sent` `{followUp}` when the user sends a
  message to the coach (`followUp` = false on the opening message, true on a
  follow-up to an open trajectory), `coach_proposal`
  `{status:"proposed"|"no_valid_adjustment", round}` when a proposal round
  returns, `coach_plan_applied` when the user accepts one —
  `src/modals/CoachChat.tsx`. Limited: never the message text, the plan, or the
  tool calls (those live server-side in `agent_rounds`).
- Catalogue events (Phase 2): `race_contributed` `{kind:"race"|"edition"}` when a
  user adds to the shared catalogue (`src/modals/RaceFormModal.tsx`); `find_near_me`
  `{}` the first time the "Near me" toggle is enabled in Races → Find a race
  (`src/views/RacesView.tsx`). Both limited — enum/no-args only, **never** race
  names, free text, or the user's location/coordinates.
- Route finder: `route_suggested` `{}` when a generation starts
  (`src/modals/RouteFinderSheet.tsx`). No coordinates, no distance — the point
  is only how often the feature is used.
- Premium: `premium_teaser_shown` `{feature}` when a free user opens the
  "premium feature" sheet (`src/modals/PremiumTeaserSheet.tsx`). `feature` is a
  fixed slug (`"routeFinder"`), never free text. This is the demand signal for
  the paid tier — how many people reach for a premium feature before there is
  anything to sell. See `docs/monetization.md`.
- Settings → Privacy toggle (reads/writes consent directly) —
  `src/modals/SettingsModal.tsx`.

## How the PostHog adapter maps to the seam

`src/telemetry/posthog.ts` implements:

```js
isConfigured(): boolean              // !!VITE_POSTHOG_KEY
init(): void                         // load SDK (dynamic import) + opt_in_capturing
shutdown(): void                     // opt_out_capturing
identify(id): void                   // posthog.identify(supabaseUserId)
reset(): void                        // posthog.reset()
track(event, props): void            // posthog.capture(event, { ...props, native })
captureError(error, context): void   // posthog.captureException; context: { kind, componentStack }
```

Consent is driven entirely from `opt_in_capturing` / `opt_out_capturing` (the
SDK loads in `opt_out_capturing_by_default` mode), so a single import serves both
states. `init`/`track`/`identify` run through a tiny queue that replays calls
made before the dynamic import resolves.

`captureError` carries a defensive opted-out path: if it's ever called while the
SDK is opted out, it opts in just long enough to send the one exception and does
**not** synchronously re-opt-out (that would risk dropping the still-queued
report) — the next reload re-reads the persisted opt-out and starts paused again.
In normal flow this branch is dormant: every crash call site already checks
`getConsent()` first, so `captureError` runs only when the SDK is opted in.

## Swapping vendors

Replace `const provider = posthogProvider;` in `src/telemetry/index.ts` with
another adapter implementing the interface above; keep the SDK import confined to
that one adapter file, read keys from `import.meta.env.VITE_*` (no baked-in
default, like `MAP_KEY`), gate any native-only SDK pieces on `isNative`, and
prefer the vendor's EU/privacy host. For example **Sentry** (`@sentry/react` +
`@sentry/capacitor`) would wire its `beforeSend` to drop events when
`getConsent()` is false, so even native background errors honour consent.
