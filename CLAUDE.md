# Running Coach

A React 19 + Vite single-page running-training app. State is client-side and
mirrored through `db` into an in-memory cache that debounce-upserts to a single
per-user Supabase `app_state` JSONB row. It's failure-tolerant: a failed load
falls back to an empty cache so the app still renders.

## Maintaining this file
Keep this file lean and current: durable, cross-cutting rules only. Deep
per-feature detail lives in `docs/` (index at the bottom) — when you learn
something durable, put a one-line rule here only if it applies across tasks;
otherwise update the relevant `docs/` file in the same change. Record reusable
rules, not a changelog; delete anything stale.

## Setup & commands
- A Claude Code SessionStart hook (`.claude/hooks/session-start.sh`) runs
  `npm install` automatically in web sessions. In any other fresh checkout run
  `npm install` first — deps are not committed, so everything below fails with
  module-not-found until you do.
- `npm run dev` — Vite dev server.
- `npm test` — Vitest (run mode); `npm run test:watch` for watch. Suite lives
  in `src/**/*.test.{ts,tsx}`.
- `npm run lint` — ESLint (flat config). Catches unused imports/vars; keep it clean.
- `npm run typecheck` — app TS check; `npm run typecheck:supabase` — Deno check
  for edge functions; `npm run typecheck:all` — both (CI runs this).
- `npm run build` — production build (runs `typecheck` first) → `dist` for
  S3/CloudFront.

## TypeScript
- App source and tests live in `src/**/*.{ts,tsx}`; no new `.js`/`.jsx` in
  `src/`. Use `.tsx` only for files containing JSX.
- **Stay on TypeScript 6.x**: `typescript-eslint` doesn't support the TS 7
  native compiler yet. Don't bump `typescript` past 6.x in a routine dependency
  update until it declares TS 7 support.
- No file-level `// @ts-nocheck` in app source; prefer narrow local
  aliases/interfaces when a module needs incremental typing.
- Edge-function entrypoints are Deno TypeScript (`deno check` via
  `npm run typecheck:supabase`); keep Deno-specific code out of the browser
  ESLint config.

## Architecture
- **Entry gate (`src/App.tsx`):** one branch on the auth session. Signed-out
  web gets the lazy marketing chunk (`src/marketing/MarketingGate.tsx`) wrapped
  in `ChunkLoadBoundary` (fallback: the static `LoginScreen`; swallows only
  chunk-load errors) — keep any future top-level `lazy()` gate behind this same
  pattern. Web-only-and-heavy code goes behind the build-time
  `import.meta.env.VITE_NATIVE_BUILD` flag (constant-folded out of native
  builds), not a bare `isNative` runtime check, which still ships the code in
  the APK. Marketing copy commitments, SEO, and the brand mark:
  `docs/marketing.md`.
- **No router.** `src/RunningCoach.tsx` is the single state hub: it owns
  `runs`, `plan`, `settings`, modal flags, and the active `tab`, and passes a
  `shared` props bag down to every view; views switch on `tab`. Nav: Record is
  a center FAB (an action, not a destination); the four row tabs are Home ·
  Plan · Races · Progress. To add cross-view state or an action, define it
  there and add it to `shared` (e.g. `goTab`, `goLog`, `addRuns`).
- **Layout:** views in `src/views/`, modals/full-screen flows in `src/modals/`,
  reusable widgets in `src/components/`, pure helpers in `src/utils/`.
- **Persistence:** `db.get/set(STORAGE_KEYS.*)` (`src/db.ts`,
  `src/constants.ts`). Every state change is mirrored to `db` in the same
  handler that calls `setState`. Writes debounce ~600ms into a single upsert
  and flush on page hide/unload.
- **A failed load must never become a write.** The upsert replaces the whole
  `data` blob, so an unpopulated cache would erase the row — one offline cold
  start once wiped a real user's runs and plan. `initStore` resolves
  `false` on a failed read and the store stays read-only (`isStoreLoaded()`)
  until a load succeeds; `App.tsx` renders `StoreLoadError` (retry) rather than
  falling through to the app, which would read as a new account and trigger
  onboarding. Never "recover" from a read failure with an empty default.
- **Supabase config:** URL + anon key in `src/config.ts`.
  `VITE_SUPABASE_URL` is required at build time; workflows construct it from
  repo variable `SUPABASE_PROJECT_REF`. Don't hardcode project refs or
  credentials anywhere else.
- **AWS resources are Terraform** (`infra/`, state in `s3://run-app-tfstate`).
  New AWS resources are declared there, not clicked in the console or created
  with a one-off CLI call. `terraform.yml` plans on PRs (comment) and **applies
  on merge to `main`** — so merging an `infra/` change changes AWS. Apply
  refuses any plan that destroys or replaces a resource unless dispatched with
  `allow_destroy`; the backup bucket also carries `prevent_destroy`. Resources
  that predate Terraform are adopted with `import` blocks, and you only apply
  once `terraform plan` reports no changes. Account-wide things shared with
  unrelated projects (the GitHub OIDC provider) stay `data` sources so this
  config can never destroy them. Detail: `infra/README.md`.
- **Migrations are append-only** once a version may have reached Supabase:
  never rename/remove a pushed `supabase/migrations/*.sql` version — keep a
  no-op marker and put real schema in a later migration. **Never hand-pick the
  timestamp** — use `supabase migration new <name>`, which stamps a real UTC
  one. Supabase keys applied migrations by the version prefix alone, so two
  files sharing one are indistinguishable: the second is treated as already
  applied and silently never runs (this happened on 2026-07-26 and an auth
  trigger went missing). `src/migrations.test.ts` fails CI on a collision.
  Apply with `supabase db push`, never a path that assigns its own version, or
  the repo and `schema_migrations` drift apart and `db push` stops working.
- **Auth callbacks:** every native deep link is classified by the pure
  `classifyAuthUrl` (`src/utils/authCallback.ts`) before App acts on it — Polar
  return first (its `?code=` is not a Supabase code), then provider error, then
  email-change OTP (`?token_hash=&type=`, which needs `verifyOtp`, not the PKCE
  exchange), then `?code=`, then GoTrue's bare `?message=` notice. Params are
  read from the query *and* the fragment. Add new callback shapes there, with a
  test, not as another branch in `App.tsx`. **Every branch must end in visible
  feedback**: a signed-in user never sees `LoginScreen`, so an auth failure
  reported there is invisible — emit `AUTH_NOTICE_EVENT` (toasted by
  `RunningCoach`) instead. `auth.users.email` is mirrored into
  `profiles.email` by a DB trigger — never write that column from the client.
- **Email change is one link + one notification, decided by server truth.**
  `double_confirm_changes` is **off** (two links to open read as a bug), so the
  confirmation goes to the new address only and the `email_changed` notification
  tells the old one afterwards — keep that notification on, it's the only thing
  left guarding against a silent takeover. The redirect can't tell you where the
  change stands (the link is opened in the new inbox, usually another device,
  where its `?code=` is unexchangeable even though the change landed), so always
  re-read the user (`refreshSession`) and let `user.new_email` decide what to
  say — `settleEmailChange` in `App.tsx`. Supabase Auth email templates are
  project config, not migrations: `supabase/templates/*.html` is the source of
  truth and the hosted project's copy is synced by hand (`docs/release.md`).
- **Multi-user:** open public signups — no single-user assumptions; per-user
  isolation via RLS on `app_state` and `profiles`.
- **Plan building:** `buildPlan(raceDate, goalSec, planSessions, distanceKm,
  raceElevation, opts)` (`src/utils/plan.ts`) is the one plan author. Style
  pace multipliers live in `supabase/functions/_shared/coach/styles.mjs`
  (app re-export `src/utils/planStyles.ts`) — never hardcode the ratios.
  Every buildPlan call site must pass `style: settings.planStyle` (a missed
  site silently rebuilds as `balanced`, whose output is frozen by snapshot
  tests). New styles must stay validator-clean by construction
  (`coachValidation.test.ts` matrix). Rebuilds that replace an existing plan go
  through `carryProgress` so done/skipped aren't wiped. Detail (opts, long-run
  scaling, fitness level, suggested days): `docs/training-plan.md`.
- **Best efforts** (fastest 1K/5K/10K/half/marathon in a run) are extracted
  **once at save time** from the trace and stored on the run as `bestEfforts`,
  so every PB comparison is an in-memory scan of `runs` — never refetch traces
  to rank a run. Read them through `effortsFor` / `rankRunEfforts`
  (`src/utils/bestEfforts.ts`), never off the raw field — that's where the
  whole-run estimate fills the distances a trace missed, and where walks and
  `OTHER` entries are kept out of the pool. No surface may claim more than the
  log supports (`isFirstEffort` vs `isPersonalBest`, and `EffortRank.estimated`
  per distance). Detail: `docs/best-efforts.md`.
- `raceDate`, `distanceKm`, `goalSec` start **empty** (`""`) — no seeded race
  defaults; guard before reading them.
- **Derived-state resets happen during render, not in effects** — see the
  `if (plan !== prevPlan)` pattern in `PlanView.tsx`. Related: no sync setState
  in effects (the `react-hooks` rule); reconcile in event handlers.
- **Premium gating:** entitlement is `profiles.premium_until` (+ `premium_since`
  for loyalty history), **service-role-writable only** — never put it in the
  `app_state` blob, which the user can write. `src/premium.ts` reads the caller's
  own row for UI only (`isPremiumActive`); **the gate is always server-side** in
  the feature's edge function. `App.tsx` owns the fetch (once per sign-in,
  refreshed when an entry point is tapped) and threads `isPremium` through the
  `shared` bag. A failed read means free, so premium checks must degrade safely.
  **The tier is not unveiled yet:** `canShowPremiumTeaser` is `false`, so a free
  user sees **no** premium entry point on any platform — gate every premium
  affordance on `isPremium || canShowPremiumTeaser`, never on `isPremium` alone,
  so the whole tier reveals by flipping that one flag. New premium features land
  premium-first — never claw back something already free. See
  `docs/monetization.md` (which also lists the planned premium features).
- **Telemetry:** everything goes through the vendor-agnostic seam
  `src/telemetry/index.ts`; only `src/telemetry/posthog.ts` imports the SDK
  (dynamic import, no-op until `VITE_POSTHOG_KEY`). Consent is opt-in,
  per-device (`localStorage`, not the synced blob). Autocapture and session
  recording stay OFF. Read `docs/telemetry.md` before adding/swapping a
  provider or an event.

## Native platforms (Capacitor shells)
- **One bundle serves web + both shells**; `isNative`
  (`src/native.ts`) is the runtime split and is false in any browser — the web
  build must stay unchanged by native work. `platform`/`isAndroid`/`isIos`
  gate platform-exclusive integrations; a synced preference naming the other
  platform's integration must degrade to "off" locally, never render its UI.
- **Seams:** all GPS goes through `geoSource` (`src/geo/source.ts`) behind
  `useRunTracker`; all external HR through `getHrSource` (`src/hr/source.ts`);
  all run imports through the provider registry (`src/imports/`). Add sources
  by implementing the interface — never touch `navigator.geolocation` or a
  native bridge directly from UI code.
- **Anything that must keep working with the screen off rides the accepted-GPS-fix
  render path, never a timer** — background JS timers are throttled to a crawl,
  which is exactly when a run is being recorded. The lock-screen notification
  (`useRunTracker`) and live-sharing uploads (`docs/live-sharing.md`) both do
  this; a stationary runner emits no fixes, so the *consumer* owns staleness.
- **Synced preferences vs per-device grants:** OS permissions and device
  pairings are per-install. A synced setting (`hrMethod`, `watchImport`) is a
  *preference*; check the local per-device marker before touching any native
  bridge.
- **Backgrounded Android runs NO JS.** Once the app leaves the foreground the
  WebView's task queues are frozen — a native bridge callback does not wake it,
  so anything that must keep changing with the screen off (the live-run
  notification's distance/pace) has to be computed natively, with JS pushing a
  seed. Numbers read on the Java side need a `Number`-tolerant reader:
  `PluginCall.getDouble` returns its default for a `Long`, which every epoch-ms
  value becomes. Detail: `docs/live-tracking.md`.
- **iOS 15.0 is the deployment floor, and a regex lookbehind (`(?<=`/`(?<!`)
  anywhere in the bundle breaks it** — JavaScriptCore before 16.4 fails to
  *parse* the module, so the whole chunk dies (a lazily-imported one as an
  unhandled rejection). It reaches us through dependencies, not our own code, so
  `scripts/check-bundle-regex.mjs` scans the build output and fails
  `npm run build`; fix a dependency with `patch-package`. Lookahead, named
  groups and `\p{…}` are fine.
- **`build.target` must never outrun `IPHONEOS_DEPLOYMENT_TARGET`** — WKWebView's
  engine is the OS version, so an iOS 15 shell runs a Safari 15 engine. Vite's
  default is `baseline-widely-available` (= ios16.4), so the target is pinned in
  `vite.config.ts` and `src/iosCompat.test.ts` fails CI if the two drift. It
  lowers *syntax* only — no regex feature is ever lowered, and no API polyfilled.
- **A fire-and-forget `import()` must `.catch()`.** Un-caught, its rejection
  hits `ErrorBoundary`'s `unhandledrejection` listener and paints the
  full-screen crash overlay over a working app — how an unparseable prefetched
  chunk read as "signing in with Google crashes".
- Detail, including the hard-won permission/signing/build gotchas:
  `docs/live-tracking.md` (GPS, shells, R8, patches),
  `docs/health-integrations.md` (HR, watch/file/cloud imports),
  `docs/background-location.md`, `docs/release.md` (stores, signing,
  versioning).

## AI coach agent
Propose-and-confirm plan **editor, never author** — `buildPlan` stays the
author. The model API keys, validator, tools, rate limit, and audit log live
server-side in `supabase/functions/coach-agent`. The provider follows the
`COACH_MODEL` name (default `claude-sonnet-5` via the Anthropic SDK; Mistral
models route through the `_shared/coach/mistral.mjs` adapter — engine and
tools stay provider-agnostic); shared logic is plain ESM in
`supabase/functions/_shared/coach/*.mjs` (imported by both Deno and Vitest).
`confirm` makes no model call and no server write — the client applies the
returned plan via `applyCoachPlan`. `_shared/coach/runDigest.mjs` (the
read-only `get_run_detail` tool) ports `src/utils/{geo,runSeries,runSplits,
hr}.ts` — keep the algorithms in sync at both ends (parity-tested by
`src/utils/runDigest.test.ts`); digests stay coordinate-free.
**Read `docs/coach-agent.md` before
touching prompts, tools, validator rules, or the chat client** — it also covers
resiliency, usage limits, memory, history, and feedback. Evals: offline in
`npm test`; live-model in `evals/coach/` (`npm run eval:live`) — re-run after
prompt/tool-description changes.

## Data shapes
- **Run:** `{id, date, type, km, durationSec, hr, hrMax, elevation, effort,
  notes}` plus, for GPS-tracked runs, `{source:"gps", routeId}`; HR-only
  sidecar rides `hrRouteId`; transient post-run-HR markers are the
  per-platform fields `hrPending` / `hrPendingHk` (see
  `docs/health-integrations.md`). `id` is generated in `addRuns` if absent;
  runs are kept sorted newest-first. Measured best efforts ride `bestEfforts`
  (`{}` = measured, covers no standard distance; absent = never measured).
- **Route:** `run_routes` row `{id, user_id, points, stats, created_at}`;
  `points` is the simplified `[lat,lng,t,alt]` array (null = gap marker),
  `stats` is `{km, durationSec, elevation, avgPace}` plus the free-form
  sidecar (e.g. `hrSamples`).
- **Plan:** `buildPlan(...)` → `{..., weeks:[{weekNumber, startDate, phase,
  sessions:[{id, date, type, desc, km, pace, done}]}]}`. Session types: EASY,
  TEMPO, INTERVALS, LONG, RACE, WALK, OTHER.

## Conventions
- **Comments are terse.** Default to no comment — well-named code should be
  self-explanatory. When one is genuinely needed (a non-obvious constraint,
  invariant, or workaround), one line max. Going longer to document a truly
  unclear trade-off should be rare, and points at `docs/` for anything
  architectural rather than restating it inline.
- **French and Spanish copy:** French uses informal `tu` (app copy in
  `src/i18n/`; marketing uses `vous` — see `docs/marketing.md`); Spanish stays
  region-neutral. Reserve `course` / `carrera` for organized races, `sortie` /
  `entrenamiento` for logged runs. No em dashes (`—`) in either locale.
  Enforced in `src/i18n/i18n.test.ts`.
- **Animations are CSS-only** (no library): keyframes + `--animate-*` tokens in
  the one `@theme` block in `src/index.css` (Tailwind v4 CSS-first, no
  `tailwind.config`). Transform/opacity-only and short. A global
  `prefers-reduced-motion` block degrades everything; behavioural changes use
  `usePrefersReducedMotion`. Enter animations re-fire by remounting via a
  changing `key`; modals animate enter-only; only the Toast animates exit (via
  `usePresence`).
- **Any new modal/sheet must call `useDismissable`** (`src/hooks/`) so Android
  back / web Escape close it via the LIFO registry
  (`src/utils/backDismiss.ts`). Register in the overlay's OWN component; pass
  the guarded close where one exists. `OnboardingWizard` deliberately does NOT
  register (unskippable gate).
- Reuse existing form pieces: `SessionConfigurator`, `GoalConfigurator`,
  `StylePicker`, `INPUT_CLS`/`LABEL_CLS` (`src/constants.ts`), type colors
  `TCLR`, day names `DAYS`, and the `fmt` helpers (`src/utils/format.ts`).
- Session "how it unfolds" breakdowns come from the pure `sessionSteps` helper
  (`src/utils/sessionSteps.ts`) — extend its parsers (and tests) for new desc
  formats rather than special-casing the UI.
- A logged run renders as `RunRow` (`src/components/RunRow.tsx`) — shared by
  dashboard + History; use its props (`dateFmt`, `showNotes`, `actions`,
  `highlight`) rather than re-rolling the markup.
- **Surfacing an async run change** (HR relink, watch import): go through
  `goToRuns(ids, label)` (`RunningCoach.tsx`) — transient highlight + navigate
  + scroll — not a bare text toast.
- Show whole-minute durations with `fmt.mins`, never `minutes / 60`.
- **Icon-only buttons need an `aria-label`** (plus `aria-pressed` for
  toggles); buttons with adjacent visible text don't get double-labeled.
- Number inputs: keep an emptied field empty while editing — no
  `parseFloat(v) || 0` in `onChange`; coalesce at use time. Settings fields
  auto-save (commit on blur/Enter), keeping local string state.
- **Text controls render at 16px on iOS** — one `@supports
  (-webkit-touch-callout: none)` block in `src/index.css`. Anything smaller
  makes the WebView zoom the page in on focus, and Capacitor disables
  pinch-zoom, so the app stays stuck zoomed. Don't defeat it with a stronger
  font-size rule, and never "fix" zoom via `maximum-scale` / `user-scalable=no`
  in the viewport meta — that would kill pinch zoom for web users.
- **iOS safe-area insets:** any surface pinned to a screen edge must pad with
  the `--safe-top` / `--safe-bottom` CSS vars (`src/index.css`; 0 on
  web/Android) via inline `calc()`. Verify on a notched device.
- Tailwind utility classes inline; dark slate palette with orange-500 accents.
- Dates are `YYYY-MM-DD` strings; use `ymd()` and `fmt.*`
  (`src/utils/format.ts`). Parse local dates as `new Date(s + "T00:00:00")`.
- **Onboarding (`src/modals/OnboardingWizard.tsx`):** branches on
  `settings.intent` (`"race"` | `"fitness"`) via the pure `onboardingSteps`
  (`src/utils/onboarding.ts`). The **Health & safety** step is the unskippable
  medical gate — "Skip" jumps *to* it, never around it; only the summary's
  "Get started" calls `onComplete` (records `settings.healthAck`). The
  screening answer is GDPR health data — never persisted. Progress persists
  per-step via `onSaveProgress`, capped at the health step; clear
  `onboardStep`/`intent` on complete/skip. Set `onboarded: true` on any
  first-run completion/dismissal.
- `LogView` accepts a `prefill` prop and an `onSaved` callback (fires only on a
  real manual save) — used to log a run straight from a plan session and
  auto-tick it.
- **Settings = configure, not analyse.** Settings is a **hub**
  (`src/modals/SettingsModal.tsx`) whose root is only a menu; every control
  lives on a sub-page in `src/modals/settings/`: **Account** (identity,
  language, email/password, privacy, backup & restore, destructive last),
  **Integrations** (`ConnectionsCard` + the Strava/Zepp guides), **Training
  Profile** (HR zones, coach memory). Sub-pages mount over the hub and register
  their own `useDismissable`, so back pops one level. A vendor we can't connect
  to gets a *guide* in `VendorGuides.tsx` (export a file → import it here;
  vendor app → health store), never a fake integration. Analysis surfaces (full
  HR zones reference) live in Progress → Stats.

## Git / PR workflow
- **Open a PR automatically when a task is finished** — committed, pushed, and
  lint/typecheck/tests green locally. This standing maintainer instruction IS
  the explicit opt-in. Exceptions: trivial/no-op changes, a PR already open for
  the branch (push to it instead), or the maintainer said to hold off. Mirror
  any `.github/pull_request_template.md` structure.
- **Never merge a PR unless explicitly asked.**
- **After opening a PR, track its CI and auto-fix failures:** call
  `subscribe_pr_activity`, then end the turn. On CI failure, investigate and
  push in-scope fixes until green; use `AskUserQuestion` for ambiguous or
  architectural calls; surface (don't go silent on) out-of-scope or
  non-converging failures. Green CI is the terminal state — report it.
  **Don't schedule an hourly self check-in** — `subscribe_pr_activity`
  delivers CI/review/mergeability events as they happen, so a polling
  check-in on top of it just burns tokens.
- We squash-merge. A reused branch diverges after its squash-merge: before the
  next PR from the same branch, `git fetch origin main && git rebase
  origin/main` then `git push --force-with-lease`.
- PR APK builds are opt-in via the `apk` label on the PR (`android-pr.yml`);
  details + CI caching layout in `docs/release.md`.

## Deep-dive docs (`docs/`)
- `docs/marketing.md` — landing page, copy commitments, SEO, brand mark.
- `docs/training-plan.md` — buildPlan opts, methodology styles, fitness signal.
- `docs/release.md` — store releases, iOS signing, versioning/update gate,
  edge-function deploys, CI caching.
- `docs/live-tracking.md` — GPS pipeline, routes, native shells, permission
  gotchas, R8, npm patches.
- `docs/health-integrations.md` — HR sources, watch/file/cloud imports,
  dedupe rules, Health Connect/HealthKit.
- `docs/background-location.md` — Android background-location policy.
- `docs/live-sharing.md` — live run sharing (premium): transport, cadence, staleness, cleanup.
- `docs/races.md` — race catalogue, contributions, badges.
- `docs/best-efforts.md` — best-effort extraction, PB ranking, post-run reward.
- `docs/coach-agent.md` — coach architecture, validator, evals, resiliency.
- `docs/telemetry.md` — analytics/crash-reporting seam and consent.
- `docs/backups.md` — daily DB backup to S3, retention, restore procedure.
- `docs/route-finder.md` — loop route suggestions (ORS proxy, scoring, guide layer).
- `docs/integrations-polar.md` — Polar cloud import.
- `docs/monetization.md` — monetization direction, the premium seam, payments path.
- `infra/README.md` — Terraform-managed AWS resources, remote state, OIDC trust.
