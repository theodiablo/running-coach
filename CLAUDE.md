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
- **Supabase config:** URL + anon key in `src/config.ts`.
  `VITE_SUPABASE_URL` is required at build time; workflows construct it from
  repo variable `SUPABASE_PROJECT_REF`. Don't hardcode project refs or
  credentials anywhere else.
- **Migrations are append-only** once a version may have reached Supabase:
  never rename/remove a pushed `supabase/migrations/*.sql` version — keep a
  no-op marker and put real schema in a later migration.
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
- `raceDate`, `distanceKm`, `goalSec` start **empty** (`""`) — no seeded race
  defaults; guard before reading them.
- **Derived-state resets happen during render, not in effects** — see the
  `if (plan !== prevPlan)` pattern in `PlanView.tsx`. Related: no sync setState
  in effects (the `react-hooks` rule); reconcile in event handlers.
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
- **Synced preferences vs per-device grants:** OS permissions and device
  pairings are per-install. A synced setting (`hrMethod`, `watchImport`) is a
  *preference*; check the local per-device marker before touching any native
  bridge.
- Detail, including the hard-won permission/signing/build gotchas:
  `docs/live-tracking.md` (GPS, shells, R8, patches),
  `docs/health-integrations.md` (HR, watch/file/cloud imports),
  `docs/background-location.md`, `docs/release.md` (stores, signing,
  versioning).

## AI coach agent
Propose-and-confirm plan **editor, never author** — `buildPlan` stays the
author. The Anthropic key, validator, tools, rate limit, and audit log live
server-side in `supabase/functions/coach-agent`; shared logic is plain ESM in
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
  runs are kept sorted newest-first.
- **Route:** `run_routes` row `{id, user_id, points, stats, created_at}`;
  `points` is the simplified `[lat,lng,t,alt]` array (null = gap marker),
  `stats` is `{km, durationSec, elevation, avgPace}` plus the free-form
  sidecar (e.g. `hrSamples`).
- **Plan:** `buildPlan(...)` → `{..., weeks:[{weekNumber, startDate, phase,
  sessions:[{id, date, type, desc, km, pace, done}]}]}`. Session types: EASY,
  TEMPO, INTERVALS, LONG, RACE, WALK, OTHER.

## Conventions
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
- **Settings = configure, not analyse.** Section order: Profile, Privacy,
  Backup & restore, Account (destructive last). Analysis surfaces (full HR
  zones reference) live in Progress → Stats.

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
- `docs/races.md` — race catalogue, contributions, badges.
- `docs/coach-agent.md` — coach architecture, validator, evals, resiliency.
- `docs/telemetry.md` — analytics/crash-reporting seam and consent.
- `docs/route-finder.md` — loop route suggestions (ORS proxy, scoring, guide layer).
- `docs/integrations-polar.md` — Polar cloud import.
- `docs/monetization.md` — monetization direction.
