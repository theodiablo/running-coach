# Watch page CTA: finish recap and race context

Technical design for the two changes `docs/social.md` ("Live watch page CTA")
decided for the public `/watch/:token` page (`docs/live-sharing.md`). **Design
only: nothing here is built until the maintainer approves it.** Canvas:
https://claude.ai/artifact/N5kqtYR7vPTsPgDcK8oH61 (`Watch-Ended`, `Watch-Race`).

| | What | Backend | Ships |
|---|---|---|---|
| **D** | Finish recap, then "Start my plan, free" (web) before the store buttons, then Follow | none | PR 1 |
| **B** | Race context: race name, progress along its distance, expected finish, plan for the race's next edition | one column, `live-watch` read | PR 2 |

Out of scope: cheers, "Do you run too?", a course line (the catalogue has no
course geometry), any change to the follow list (`/watch/`), the native
shells, and the Android uploader.

## What the code does today

- `PublicWatch.tsx` has four states: loading, nothing live, live, ended. Ended
  is `run.status === "ended"`, **latched** in memory once seen, because Save
  deletes the row seconds after Stop.
- Ended renders `LiveWatchView` (map with endpoints, 3-tile stats, chart) with
  `EndedPromo` (title, body, store buttons) in the panel footer **on desktop
  only**. On phones the ended state shows the same pinned row as a live run
  (`PinnedPromo` with the ended title and a "Get it" button that opens
  `AboutSheet`), so the pitch is one tap deeper than the canvas shows.
- Every outbound link is built in `storeLinks.ts`; Play links carry
  `utm_source=live_share&utm_medium=watch_page&utm_campaign=race_link&utm_content=<placement>`,
  TestFlight ignores query strings (unmeasured). The token never rides in a link.
- Signed-out web visitors at `/` get `MarketingGate`; its CTAs open
  `LoginScreen` in a modal (`loginMode` `signup` or `signin`). Nothing reads the
  query string on `/` except PostHog's own UTM capture (consent-gated).
- There is **no deep link into the app for an https URL**: the shells register
  only the custom scheme `solutions.camboulive.run` (hosts `auth-callback`,
  `*-callback`), App Links / Universal Links are not claimed, and the app has no
  router (`docs/live-sharing.md`, "No native deep link"). This decides B's CTA
  below.
- The publisher opens `live_runs` with an INSERT from the JS recorder and
  continues it with UPDATEs (JS) or `live_publish_append` (native, which only
  touches `points` and `stats`). The row dies with the run.
- The catalogue (`races`, `race_editions`) is world-readable with a `verified`
  flag; only curated or maintainer-verified rows are `verified = true`
  (`docs/races.md`). Only officially announced dates exist, so an edition after
  the one raced exists only if the organiser announced it.

## D: finish recap (PR 1, web only)

### States

The page's own states do not change; only what **ended** renders does.

| State | Header | Panel (top to bottom) |
|---|---|---|
| Live, paused, quiet | unchanged (dot, title, Follow, Get the app) | unchanged |
| **Ended, with a route** | flag + "Run finished"; no Follow pill, no Get the app pill (the card below is the pitch) | recap headline, CTA card, Follow, stats, chart |
| **Ended, no usable route** (fewer than 2 points) | same | recap headline only if `km > 0` (else the existing "This run has ended"), CTA card, Follow |
| Nothing live | unchanged | unchanged (it already carries features and store buttons) |

- **Recap** replaces the 3-tile grid for ended runs: `21.1 km in 1:52:07` large,
  `5:19 /km average` under it (plus `Elev. gain` when known). Built from
  `run.stats` with the `fmt` helpers; no new data. The map already shows the
  whole route with start and finish markers.
- **CTA card** order is the canvas's: heading, one line, the primary web
  button, a one-line note, then the two store buttons (compact), visitor's own
  store first as today. The card sits **above** the stats and chart so it is on
  screen at 390x844 without scrolling the panel; the chart stays but moves below.
- **Follow** becomes the large outline button under the card (the existing
  `FollowControl large`), worded for the moment: "Follow, to see their next run
  here". It keeps its behaviour and storage rules untouched
  (`docs/live-sharing.md`, "The list lives in the visitor's browser").
- **`PinnedPromo` is not rendered when ended** (the card replaces it), and the
  card shows at every width, not only in the desktop side panel. `LiveWatchView`
  gains one optional `recap` slot and renders `panelFooter` before the chart when
  it is set; the in-app `LiveWatchModal` passes neither, so it is unchanged.
- The canvas's "7 cheers along the way" is dropped (cheers are out of scope).

### Copy (`liveShare.public.*`, en / fr / es)

French on this page is **`vous`**; Spanish informal and region-neutral; no
em dashes; "course" is for races and "sortie" for logged runs
(`i18n.test.ts` pins the register). New keys; the old `endedTitle` and
`endedBody` are removed with the card they belonged to:

| Key | en | fr (vous) | es |
|---|---|---|---|
| `recap.headline` | `{{distance}} in {{time}}` | `{{distance}} en {{time}}` | `{{distance}} en {{time}}` |
| `recap.pace` | `{{pace}} average` | `{{pace}} de moyenne` | `{{pace}} de media` |
| `cta.title` | Ready for your own finish line? | Et si c'était vous, la prochaine fois ? | ¿Te animas con tu propia meta? |
| `cta.body` | Pick a race and a free plan takes you all the way there. | Choisissez une course : un plan gratuit vous conduit jusqu'à la ligne d'arrivée. | Elige una carrera y un plan gratis te lleva hasta la meta. |
| `cta.button` | Start my plan, free | Créer mon plan, gratuit | Empezar mi plan, gratis |
| `cta.note` | Right here in the browser with a free account. Get the app later to record runs. | Directement dans le navigateur, avec un compte gratuit. L'appli viendra ensuite pour enregistrer vos sorties. | Aquí mismo en el navegador, con una cuenta gratis. La app llega después para grabar tus salidas. |
| `follow.endedCta` | Follow, to see their next run here | Suivre, pour voir leur prochaine sortie ici | Seguir, para ver aquí su próxima salida |

**No time or effort claims.** The canvas's "in two minutes" is dropped: nothing
measures onboarding length (`docs/marketing.md` holds the copy commitments), so
the copy sells the destination (the finish line) instead of the effort. Any
future number must be measured first.

### Where the web CTA lands

`/` with the placement and one intent flag:

`https://run.camboulive.solutions/?utm_source=live_share&utm_medium=watch_page&utm_campaign=race_link&utm_content=ended_web&start=plan`

(relative `/?...` like `siteLink`, so a PR preview or local origin works.)

- **Signed out** (the target visitor): `MarketingGate` opens `LoginScreen` in
  **signup** mode on first render when it sees `start=plan`, so one tap reaches
  the account form, not the marketing landing. Closing the modal leaves the
  landing. After sign-up the existing onboarding runs unchanged (intent step,
  race branch, health gate).
- **Signed in**: with a plan, `start` is read and dropped (a runner who already
  has one is never ambushed). Without one (a race-day runner, `inRaceDayMode`),
  the intent opens the same "get a plan" prompt that `RaceDayPlanRow` offers,
  once the store is reconciled, so the button never lands on nothing.
- **How the flag survives the sign-up round trip.** Google/Apple OAuth leaves
  the page and returns to the origin, so a query-string read at the gate would
  be gone. A pure `src/utils/landingIntent.ts` (`parseLandingIntent`,
  `captureLandingIntent`, `peekLandingIntent`, `consumeLandingIntent`) reads
  `start` (and, in PR 2, `race`) once in `main.tsx` before `<App/>` (the
  `cloudOauthPreinit` slot), validates it, writes it to **`sessionStorage`** and
  removes **only those params** from the URL. UTMs stay, because PostHog reads
  them at pageview time and stripping them would blind the one attribution we
  have. `sessionStorage` is tab-scoped and gone on close; the write is a result
  of the visitor pressing "Start my plan", i.e. storage needed to complete the
  action they asked for (the same footing as `rc_lang`). An email-confirmation
  link opened on another device loses it, and the visitor simply meets the
  normal onboarding: the degrade is graceful by construction.
- Native builds never run this page (`VITE_NATIVE_BUILD`), so no native work.

### Placement tracking (`storeLinks.ts`)

`PromoPlacement` gains `ended_web`. Existing values keep their meaning, so the
Play Console series stay continuous; the ended card's store buttons keep
`ended`. A new `planLink(placement, race?)` builds the `/?...` URL above and,
like every link here, can never carry the share token (the existing test that
asserts this grows to cover it).

What is and is not measurable, so it is not rediscovered as a bug:

- Play installs by `utm_content`: Play Console (unchanged).
- iPhone taps: unmeasured (TestFlight ignores query strings). The web CTA is the
  one measurable path for iOS visitors.
- Web landings: PostHog's initial UTM person properties, **only for visitors who
  accept analytics** (the page's cookieless telemetry emits `$pageview` only and
  never sees a click). A server-side click counter (a `/get`-style redirect) is
  possible but is a new surface; not proposed.
- No new telemetry events in PR 1 (`docs/telemetry.md`: `track()` is dead on
  the public page and consent-gated in the app).

### Tests (D)

- `storeLinks.test.ts`: `ended_web` placement, `planLink` shape, no token in any
  link.
- `landingIntent.test.ts`: parse, junk rejected, only `start`/`race` stripped,
  UTMs kept, stash round trip, consumed once, storage blocked.
- `MarketingGate.test.tsx`: `start=plan` opens the signup modal; absent opens
  nothing.
- `PublicWatch.test.tsx`: ended state shows recap, web CTA before the store
  buttons, large Follow, no pinned row; live and idle unchanged; a run with no
  trace; `km: 0`; hrefs contain no token.
- `i18n.test.ts` passes untouched (register, em dashes, key parity en/fr/es).
- By hand: 390x844 and desktop, three locales, dark palette, notched device for
  the card's bottom padding (`--safe-bottom`), screenshots in the PR.

## B: race context (PR 2)

### Who gets it

Race-day mode only (`inRaceDayMode`: `settings.liveFirst` and no plan), the
runner who installed to be followed on one race. The race is a **participation,
never a plan target** (`docs/live-sharing.md`, "Race-day onboarding"), so its
`editionId` already lives on a wishlisted `Participation`. A runner with a plan
and a RACE session is not covered; the same column would serve them later by
reading the session's `editionId` (noted, not built).

`raceDayEdition(parts, settings, plan, startedAt)` joins `src/utils/raceDay.ts`:
returns the `editionId` of the single wishlisted participation whose `raceDate`
equals the local date the run **started**, else `null`. **Two matches the same
day is no match** (a festival with a 10K and a half): never guess which race
a link names.

### Data path

1. **Migration** (`supabase migration new live_runs_race_edition`, never
   hand-timestamped): `alter table public.live_runs add column if not exists
   race_edition_id text` with a length check (1 to 160, matching
   `slug-YYYY-MM-DD[-km]`). No foreign key: editions are corrected in place and
   occasionally deleted, and a dangling id must simply resolve to nothing. No
   index: it is only ever read off the user's own row. `live_runs` already
   grants the client table-level insert/update and `service_role` all, so no
   new grant is needed. `live_publish_append` is untouched.
2. **Publisher** (`src/live/publisher.ts`): `PublishArgs.raceEditionId`, written
   on the **INSERT only**. A run's race is fixed when the row opens; UPDATEs and
   the native append never carry it, so the Android uploader needs no change.
   `missingColumn()` learns `race_edition_id` and drops it silently on PGRST204
   (nothing to un-offer in the UI: the page just shows no race). A recovered run
   re-inserts and re-resolves from its own start time, so a restart after
   midnight still names the race.
3. **Recorder wiring**: `RunningCoach` computes `raceDayEdition(...)` and passes
   it into `LiveRunTracker`, which hands it to `publishLiveRun`. Two notices:
   - The share panel gets one line when a race will be named ("Your link will
     show that you are running the {race}"), where the switch is.
   - **A one-time acknowledgement for runners whose sharing is already on.** The
     switch persists (`LIVE_SHARE_KEY`) and is restored on mount, so such a
     runner can start a broadcast without ever opening the panel. A synced flag,
     `raceNameNoticeSeen`, gates the feature. It is the **inverse** of the coach
     signposts (`coachIntroSeen`: absent means never show): here **absent means
     unseen**, so every existing account, which has no value, gets the notice
     (read it as `!== true`). Until it is `true`
     `raceDayEdition` is passed as `null`, so **no broadcast names a race before
     the runner has seen the notice**. The notice is a short confirm on the
     race-day Start path (`ModalOverlay` + `ConfirmButtons`, registered with
     `useDismissable`) that says what the link will show; any answer spends it
     (acknowledgement only, no opt-out, per the "no toggle" decision), and
     closing it without answering leaves the flag unset, so the race is simply
     not named that run and the notice returns on the next one.
4. **`live-watch` read** (single `GET`/path read only; the batch is untouched):
   - The ledger-path select adds `race_edition_id`. The existing 42703 branch
     answers `notLive()` for any missing column, which would blank **every**
     link during the deploy gap, so the new column gets its own handling: on a
     42703 naming `race_edition_id`, latch `raceColumnMissing`, log once, and
     re-read without it. The legacy path never names it.
   - A visible row (same gates as today: `share_public`, 6h window) is passed to
     the pure `resolveRaceContext` in `supabase/functions/_shared/liveRace.mjs`
     (Deno + Vitest, the `liveWatchBatch.mjs` pattern), fed by two catalogue
     reads with the service role: the edition with its race, and the **next
     edition**.
   - **Verified only.** Both the race and the edition must be `verified = true`,
     else no race context. Contributed rows are user text, and this is a public
     page about a stranger; an unverified race simply gets today's page until
     `validate-contribution` verifies it.
   - **Honest-date guard.** The edition's date must be within one day of the
     run's `started_at`. A stale id or a tampered client therefore cannot hang a
     race name on an ordinary training run.
   - **Next edition**: the earliest verified edition of the same `race_slug`,
     dated after the raced edition **and not in the past**, whose distance is
     within the catalogue's own +/-5% match (the rule `matchingEditions` mirrors).
     Absent when the organiser has not announced one: nothing is ever derived by
     adding a year.
   - The **catalogue lookup** (race, edition, next edition) is cached in the
     isolate per edition id (10 minutes, 500 entries, negatives included),
     because the page polls every 30s per viewer and the catalogue changes
     weekly. The date guard is **not** cached: it runs per request against that
     run's `started_at`, so a mismatched run can neither borrow context cached
     for a valid one nor poison it.
   - Response: `run.race = { name, distanceKm, next: { editionId, date } | null }`,
     present only on a visible run, so it adds no oracle (an invisible run is the
     same `{ live: false }`). It is on `ended` rows too, so the finish recap can
     name the race.
5. **Types**: `LiveRunRow` gains `race_edition_id?`; `PublicLiveRun` becomes
   `Omit<LiveRunRow, "user_id" | "race_edition_id"> & { race?: PublicRace }`, so
   the raw column can never type-check onto the wire.

### What the watcher may learn

| Learns | Never |
|---|---|
| The race's public catalogue name | the account id, the raced edition's id |
| Its official distance | goal time, participation status, plan, name |
| The next edition's id and date (public catalogue) | the runner's other races or history |

The link holder already knows who the runner is (they were sent the link), and
the map already shows where. The race name adds identity of the *event*, not of
the account. `answerEntry` whitelists fields, so the follow list's batch cannot
leak `race` by accident; a test pins it.

### The page

- **Header**: "Racing now" over the race name replaces "Live run" (still a
  single line, truncating). The Live dot stays.
- **Progress** under the header: a bar and `km 14.2 of 21.1` from `stats.km` and
  the catalogue distance, plus `Expected finish around 10:47`. Pure
  `raceProgress` (`src/watch/raceProgress.ts`):
  - fraction clamped to 99% until `ended` (GPS reads long against the official
    distance); at or past the distance but not ended it says "final stretch"
    rather than 100%;
  - expected finish = the position's `updated_at` + remaining km x the run's
    **average** pace (not `curPace`, which is noise at a gel station), shown in
    the **viewer's** local time; hidden below 1 km or 5% done, while paused or
    quiet (`liveRowState`), when pace is 0, or past the distance;
  - never claims a goal or a target time: those are private.
- **Map and stats**: unchanged. No course line.
- **CTA section** (live and ended, state matrix below), copy keys `race.*`:
  - en: title `Be on the {{race}} start line in {{year}}`, body `A free plan,
    built around the {{year}} race date, gets you there.`, button `Get a plan
    for this race`, note `Opens the race in your browser with a free account.`
  - fr (vous): `Soyez au départ de {{race}} en {{year}}`, `Un plan gratuit, construit
    autour de la date {{year}}, vous y conduit.`, `Obtenir un plan pour cette
    course`, `S'ouvre dans votre navigateur, avec un compte gratuit.`
  - es: `Estarás en la salida de {{race}} en {{year}}`, `Un plan gratis, construido
    alrededor de la fecha de {{year}}, te lleva hasta allí.`, `Conseguir un plan
    para esta carrera`, `Se abre en tu navegador, con una cuenta gratis.`
  - The canvas body ends "like the one this runner followed". **Drop that
    phrase:** a race-day runner has no plan by construction (`inRaceDayMode`),
    so it would be false for everyone this feature serves.
  - The canvas note "Opens the race in the app, or the store if you don't have it
    yet" **cannot be built honestly**: there is no https deep link into the app
    (see above). The button goes to the web app with the race
    (`planLink("race_web", next.editionId)`), the store buttons sit under it
    with `race_store`. A native deep link is deferred, see "Later" below.

| State | CTA |
|---|---|
| Race, `next` present, live/paused/quiet | race card (pinned row on phones, as the canvas) |
| Race, `next` present, ended | race card **replaces** D's generic "Your turn?" |
| Race, `next` null (none announced) | D's generic card (ended) / today's pinned row (live): no guessed date |
| No race (not race-day mode, unverified, mismatch) | today's page / D |

### Landing the race

`planLink("race_web", editionId)` adds `&race=<editionId>`. `landingIntent`
validates it (`^[a-z0-9][a-z0-9-]{0,159}$`) and stashes it with `start`.

- **Not onboarded**: `OnboardingWizard` pre-selects `intent: "race"` when none is
  saved, jumps to the race step with the edition already picked (resolved with
  `listKnownRaces({ editionIds })` and applied through the same handler a search
  pick uses), goal step next. The intent step stays reachable via Back and the
  health gate is untouched. An id that no longer resolves falls back to the
  normal picker silently.
- **Onboarded and signed in**: after `isStoreReconciled()`, `RunningCoach` opens
  the race's `RaceSheet` (read-only; nothing is wishlisted or written on the
  visitor's behalf), then consumes the intent.
- Consumed on first use and cleared on sign-out; a stale stash never opens
  anything in a later session.

### Deploy ordering

Functions deploy on merge, migrations minutes later, the app bundle only when
promoted (`docs/release.md`), with no ordering between them. Every pairing
degrades to today's page, never to an error:

| Ahead | Behind | Result |
|---|---|---|
| `live-watch` | migration | latched, re-read without the column, no race context |
| app (insert) | migration | PGRST204 dropped, no race stored |
| migration | everything | column null, no race context |
| page | old `live-watch` | no `run.race`, today's page |
| old bundle on another device | any | never writes the column |

PR 1 has no backend dependency and can ship, and be promoted, at any time.

### Tests (B)

- `liveRace.test.ts` (pure): verified-only, date guard +/-1 day, next-edition
  selection (+/-5% distance, strictly later, not in the past, none announced),
  unknown/dangling id, response never contains the raced edition id or any
  `user_id`.
- `liveWatchBatch.test.ts`: `answerEntry` never emits `race`.
- `publisher.test.ts`: `race_edition_id` on insert only, never on update, PGRST204
  drops it without the share-public callback, recovered run re-inserts it.
- `raceDay.test.ts`: `raceDayEdition` (race day, other day, two the same day,
  plan present, no edition id).
- `raceProgress.test.ts`: clamp at 99%, final stretch, each hide condition,
  viewer-timezone formatting.
- `PublicWatch.test.tsx`: race header, progress, both CTA states, no `race`
  field renders today's page, hrefs carry the edition and no token.
- `OnboardingWizard` / `RunningCoach` tests: pre-picked race, unresolvable id,
  onboarded visitor opens the sheet once.
- Deno `typecheck:supabase` for the function; `src/migrationConventions.test.ts`
  and `migrations.test.ts` cover the file. There are no database tests, so
  after merge a read-only `execute_sql` confirms the column, and one real
  race-day-mode run on a device (or a seeded row) confirms the page end to end
  before promotion.
- No live-model evals: nothing here touches the coach.

## PR split

1. **PR 1: D.** `PublicWatch` ended state, `LiveWatchView` recap slot,
   `AppPromo` ended card, `storeLinks.ts`, `landingIntent.ts` (`start` only),
   `MarketingGate` signup-on-arrival, en/fr/es copy, tests, docs. Web only, no
   migration, no function change.
2. **PR 2: B.** Migration, publisher, `raceDayEdition` and its wiring,
   `live-watch` + `_shared/liveRace.mjs`, page UI and `raceProgress`, `race`
   in `landingIntent`, onboarding/`RunningCoach` landing, share-panel
   disclosure, `public/privacy.html` ("Sharing a run live" now says the link can
   name the race), docs. If review size asks for it, split along the deploy
   line: **2a** migration, `live-watch`, `liveRace.mjs` and their tests (nothing
   writes the column yet, so nothing is exposed); **2b** the publisher wiring,
   **together with** the share-panel disclosure and the privacy page, then the
   page and landing. **The publisher never ships ahead of the notices that tell
   a runner their link can name the race.**

Docs updated with the code: `docs/live-sharing.md` (Shape table, "The public
page promotes the app", "What the watcher may learn"), `docs/races.md` (the
page reads verified editions), `docs/social.md` (status; it lives on PR #376's
branch), this file reduced to what is built.

## Later: native deep link (deferred, not planned)

Decided to skip for now; kept here so it is not re-derived. Opening the app
from an https link would need: `assetlinks.json` and `apple-app-site-association`
served from `run.camboulive.solutions` (CloudFront, Terraform), Android intent
filters with `autoVerify` and the iOS associated-domains entitlement (a store
release for both), and URL handling next to `classifyAuthUrl` that opens the
race's `RaceSheet`. It only helps a visitor who already has the app installed,
which is the minority of people opening a stranger's link, so the web path
stays the default. If it is built, the web CTA remains the fallback.

## Decisions (settled)

1. **Native deep link**: skipped, see "Later". PR 2 is web plus store only.
2. **Naming the race**: on by default when race-day mode matches, disclosed on
   the share panel and by a one-time notice, no second toggle.
3. **Unverified races** get no race context until verified.
4. **Copy**: no time claims; "like the one this runner followed" dropped; CTAs
   sell the finish line and the start line instead.
5. **Race-day mode only** in PR 2; runners with a plan and a RACE session are a
   follow-up on the same column.
