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

`capture_heatmaps`, `capture_dead_clicks` and `capture_performance` are set to
`false` explicitly rather than left to their defaults: we use none of them, and
they are product analytics, so they must not ride along on a crash-only consent
(or get switched on by PostHog's remote config).

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

**Two channels, both opt-in.** Crash reports and product analytics are separate
consents with separate switches, because they are separate asks: plenty of people
will help fix a crash without wanting their usage measured. Neither is on until
the user says so — nothing is pre-ticked, so the first-run answer is a real
choice either way.

- **Where the choice is made.** Both are answered by the first-run
  `ConsentBanner` (`src/components/ConsentBanner.tsx`), which is the *gate*
  (self-renders nothing unless telemetry is configured and the analytics key is
  still `unset`) and picks one of two presentations:
  - **native** → `ConsentScreen` (`src/components/ConsentScreen.tsx`), a
    full-screen first-run screen with one switch per channel, both off, and a
    single **Continue**. Continuing untouched is a complete refusal, which is why
    there is no separate "skip". It renders over the login screen, before the
    back/Escape dispatcher exists, so — like `OnboardingWizard` — it deliberately
    does **not** register `useDismissable`.
  - **web** → the compact bottom bar. A full-screen interstitial over the
    marketing landing is the wrong trade, so Accept/Decline there answers both
    channels together.

  Either way the choice is changeable any time in **Settings → Privacy**, which
  carries the same two toggles.
- **Consent is per-device**, in `localStorage`, deliberately *not* in the synced
  app_state blob: consent to store data on a device is inherently per-device, so
  a fresh browser should ask again. Two tri-state keys, `"1"` granted / `"0"`
  denied / **absent = undecided** (reads as not consented):

  | Key | Channel | Absent means |
  | --- | ------- | ------------ |
  | `rc_telemetry_consent_v2` | Product analytics. Also the "has the user been asked?" flag — the first-run UI shows while it is `unset`. | undecided → off |
  | `rc_crash_consent_v1` | Crash reports. | **inherits the analytics key** |

  That inheritance is the upgrade path: the single choice these replaced covered
  *"usage analytics and crash reports"*, so an install that already answered keeps
  that answer for both — nobody is re-asked, and a "no" is never quietly upgraded
  to a "yes". The first explicit crash answer ends the inheritance.
  (`rc_telemetry_consent_v2` is itself a rotation: the old opt-out build
  *auto-wrote* the v1 key, so a v1 value meant "defaulted", not "agreed".)
- **Read them through the seam**, never off `localStorage`: `getConsent()` /
  `getConsentDecision()` (analytics), `getCrashConsent()` /
  `getCrashConsentDecision()` (crashes, inheritance applied). Write with
  `setConsent`, `setCrashConsent`, or `setTelemetryConsent({analytics, crashes})`
  — the first-run UI uses the last one so it can never leave one channel written
  and the other undecided. Every write re-syncs the provider.
- **Crashes are auto-reported on both platforms, gated on the crash channel.** A
  crash — a React render error, or an uncaught window `error` /
  `unhandledrejection` — is captured via the bundled `captureException` whenever
  `getCrashConsent()`, and never otherwise. The rule is identical on web and
  native. The `ErrorBoundary` still shows a friendly crash screen (reload +
  copy/email-trace escape hatch); it does not ask *per crash* (that native-only
  "Send report" prompt was removed when native moved to auto-report). PostHog's
  *automatic* exception capture stays off (blocked by our CSP — see above), so
  crashes ride our own handlers, not the remote bundle.
- `track()` / `identifyUser()` are gated on the **analytics** channel.
  `captureError()` is gated by its call sites on the **crash** channel (the
  `ErrorBoundary` and the web global handlers). Keep that split when extending —
  a new automatic collection surface belongs to whichever channel it measures,
  and if it isn't clearly one of the two it needs its own consent, not a
  borrowed one.
- **A crash-only consent must stay crash-only.** The SDK is opted in whenever
  *either* channel is granted, so the automatic web events ($pageview /
  $pageleave) follow the analytics channel through `set_config` rather than
  opt-in state — including on the defensive opt-in inside `captureError`, which
  would otherwise emit the deferred initial pageview for someone who only agreed
  to crash reports. `capture_heatmaps`, `capture_dead_clicks` and
  `capture_performance` are off explicitly for the same reason (they are
  analytics, and they are otherwise reachable from PostHog's remote config).

## What's wired today

- `initTelemetry()` / `installGlobalErrorHandlers()` — `src/main.tsx`.
- `ErrorBoundary` around `<App/>` — `src/main.tsx` / `src/components/ErrorBoundary.tsx`.
- First-run opt-in `ConsentBanner` (native: the full-screen `ConsentScreen`) +
  `identifyUser` / `resetUser` on auth — `src/App.tsx`.
- Events (`onboarding_completed`, `run_logged`, `plan_generated`,
  `race_target_set`, `race_completed` `{source:"manual"|"auto"}`,
  `plan_race_added` — a secondary race folded into the plan) —
  `src/RunningCoach.tsx`. Limited: counts/enums only, never race
  names/notes/times. `plan_race_added` carries no properties (there is no race
  priority/tier). **`run_logged` `{count, source}` is the "new run tracked"
  signal** — `source` is `"gps"` for a live-tracked run, `"manual"` for a
  hand-logged one, or the import provider — so filter `source = 'gps'` for runs
  recorded with live tracking.
- Overdue plan sessions (`docs/reminders.md`): `overdue_shown` `{count}` — fired
  once per change in the size of the backlog *per app session*. The
  last-reported value is module scope, NOT a component ref: Dashboard remounts
  on every tab switch and on the header brand-mark reset (`homeNonce`), and a
  ref would re-fire on each, inflating the metric. So it reads as
  "how many people are carrying open sessions and how many" — and
  `overdue_resolved` `{action:"done"|"skip"|"coach"}` when one of the card's
  actions is used (`src/views/Dashboard.tsx`). Counts and an enum only, never a
  session date or description. These two are the retention loop's own metric:
  the point of the feature is that a backlog gets resolved rather than silently
  abandoned.
- `session_reconciled` `{moved, gap}` — a run already in the log was named as
  the one that settled a plan session ("I already ran this", `ReconcileSheet`).
  `gap` is the whole-day distance between the run and the session (0-3, see
  `MATCH_WINDOW_DAYS`) and `moved` whether the session was re-dated onto the
  run's day. A boolean and a small integer only — never a date or a description.
  It measures whether the reconcile route is used at all, and how far off the
  plan real training days fall.
- `live_run_started` `{}` — fired the moment a live GPS tracking session
  actually begins (after the disclosure / permission / HR gates and the
  countdown, never on Resume) — `src/modals/LiveRunTracker.tsx`. Pairs with
  `run_logged {source:"gps"}` as a start→save funnel.
- `live_run_stopped` `{km, durationSec}` — the runner taps Finish
  (`src/modals/LiveRunTracker.tsx`). Completes the start→finish funnel with
  `live_run_started`: a start with no stop is the lost-recording signal (app
  killed mid-run). Limited: distance/duration numbers only, never coordinates.
- Live sharing: `live_share_enabled` `{}` when the runner turns the per-device
  broadcast toggle on, and `live_share_link_created` /
  `live_share_link_revoked` `{}` when they mint or withdraw a public
  `/watch/:token` link (`src/modals/LiveRunTracker.tsx`). No properties at all,
  and in particular **never the token** — it is the whole authorization for that
  page, so it must not reach an analytics vendor any more than a password would.
- Interrupted-run recovery: `live_run_recovery_offered`
  `{surface:"dashboard", points, ageMin}` when a crash-recovery buffer is
  surfaced on the Dashboard banner (`src/RunningCoach.tsx`), and
  `live_run_recovery_resumed` / `live_run_recovery_discarded` `{}` when the
  runner resolves the tracker's resume card (`src/modals/LiveRunTracker.tsx`).
  Measures how often recordings are interrupted and whether recovery works.
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
- Imports: `run_imported` `{count}` when a picked activity file lands runs in the
  log (`src/views/LogView.tsx`). A count only — never the file name, the runs, or
  where they came from. It exists to answer one question: whether file import is
  a once-per-account migration (in which case Settings is the right home for it)
  or a weekly habit for people whose watch can't reach a health store.
- Route finder: `route_suggested` `{}` when a generation starts
  (`src/modals/RouteFinderSheet.tsx`). No coordinates, no distance — the point
  is only how often the feature is used.
- Premium: `premium_teaser_shown` `{feature}` when the "premium feature" sheet
  opens (`src/modals/PremiumTeaserSheet.tsx`). `feature` is a fixed slug
  (`"routeFinder"`), never free text. It is the demand signal for the paid tier
  — how many people reach for a premium feature before there is anything to
  sell — but it is **dormant today**: premium entry points are hidden from free
  users (`canShowPremiumTeaser === false`), so this fires ~never until the tier
  is unveiled. Don't read the silence as no demand. See `docs/monetization.md`.
- Settings → Privacy toggles, one per channel (read/write consent directly) —
  `src/modals/settings/AccountPage.tsx`.

## How the PostHog adapter maps to the seam

`src/telemetry/posthog.ts` implements:

```js
isConfigured(): boolean              // !!VITE_POSTHOG_KEY
setConsent({analytics, crashes})     // load SDK (dynamic import) + opt in/out to match
identify(id): void                   // posthog.identify(supabaseUserId)
reset(): void                        // posthog.reset()
track(event, props): void            // posthog.capture(event, { ...props, native })
captureError(error, context): void   // posthog.captureException; context: { kind, componentStack }
```

Consent is driven from `opt_in_capturing` / `opt_out_capturing` (the SDK loads in
`opt_out_capturing_by_default` mode), so a single import serves both states; the
SDK is not loaded at all while both channels are off. Within an opted-in SDK the
analytics channel is *config*, not opt-in state (see the consent model above).
`setConsent`/`track`/`identify` run through a tiny queue that replays calls made
before the dynamic import resolves.

`captureError` carries a defensive opted-out path: if it's ever called while the
SDK is opted out, it opts in just long enough to send the one exception and does
**not** synchronously re-opt-out (that would risk dropping the still-queued
report) — the next reload re-reads the persisted opt-out and starts paused again.
Because the automatic web events follow the analytics channel, an SDK opted in
this way still emits nothing but the `$exception`.

## Swapping vendors

Replace `const provider = posthogProvider;` in `src/telemetry/index.ts` with
another adapter implementing the interface above; keep the SDK import confined to
that one adapter file, read keys from `import.meta.env.VITE_*` (no baked-in
default, like `MAP_KEY`), gate any native-only SDK pieces on `isNative`, and
prefer the vendor's EU/privacy host. For example **Sentry** (`@sentry/react` +
`@sentry/capacitor`) would wire its `beforeSend` to drop analytics events when
`getConsent()` is false and exceptions when `getCrashConsent()` is false, so even native background errors honour consent.
