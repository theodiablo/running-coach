# Races & badges (gamification)

The shared race catalogue, participations, completion detection, and badges.
Moved out of CLAUDE.md; keep this current when touching `src/races.ts`,
`src/utils/races.ts`, `RacesView`, or `src/utils/badges.ts`.

## Catalogue (Race → Edition)

A "race" is the recurring event, an "edition" a dated running of it (the thing
you wishlist / target / complete). Edition id = `slug-YYYY-MM-DD` (stable
across reloads; `addEdition` suffixes `-distanceKm` only on a
same-race-same-date collision).

The catalogue is **shared, global, live**: Supabase tables `races` +
`race_editions` (`supabase/migrations/20260629120000_races_catalogue.sql`;
world-readable like `app_config`, owner-scoped writes like `run_routes`, with a
hard `verified = false` with-check so a contributor can never self-verify —
only the service role does). Each account holds at most 25 unverified races and
50 unverified editions, and fields are length-bounded (`*_field_bounds`), so one
signup can't flood the catalogue. `src/races.ts` is the access module (mirrors
`src/routes.ts`: direct queries, `searchRaces`/`listKnownRaces`/`addRace`/
`addEdition`/`reportRace`). `notifyContribution` (the best-effort maintainer-email trigger)
lives in `src/notify.ts`: generic, not race-specific, so other
contribution-shaped writes (e.g. coach feedback) reuse it without importing a
races module.

**The catalogue is searched on the server, never downloaded whole.**
`search_races` (security invoker, executable by anon) takes the text, a km
range, a date window, any of several countries, terrain, verified-only and an optional point +
radius, and returns one page of races (20 by default) with all their editions,
a keyset cursor (`{key, slug}`: days to the next matching edition, or km away
when sorted by distance) and, on the first page, the total. An edition matches
when its distance is within ±5% of the range and its date in the window; a race
needs an upcoming match, except that a text search also finds a race whose
editions have all passed (so a runner can log a result for last year's race).
Text search folds case and the common accents on both sides. `race_countries`
lists the countries with an upcoming race for the country filter.
`useRaceSearch` (`src/hooks/`) is the one client: debounced 300 ms, a late
response for an older query dropped, Load more appending by cursor. Find,
the onboarding race picker, the "Add a race" duplicate check and What's next?
suggestions all go through it. `searchRaces` keeps the pages it fetched in memory
for 5 minutes (`SEARCH_CACHE_MS`, 50 pages; `race_countries` the same), so going
back to a filter or the tab answers at once with no debounce; a contribution
clears it, a failure is never cached, and nothing is persisted (the catalogue
changes weekly and the query is milliseconds). Near me sends the fix rounded to 0.01° (~1 km)
and only as a call argument: it is never stored or sent to telemetry.

Filters live in `src/utils/raceFilters.ts`: the distance slider's stops
(`DISTANCE_STOPS`, the last open-ended), what each filter sends, and
`matchingEditions`, the client mirror of the server's edition match that picks
which date a row leads with. They persist per device (`RACE_FILTERS_KEY`, not
synced); Near me never restores on, since it needs a fresh fix.

**`terrain`** (`road` | `trail`, null = unknown, shown under both) is set by the
contributor in Add a race and by the crawler (its source's sport, else trail
words in the name). The first pass over the existing rows was a guess (trail
words, or ≥ 30 m of climb per km), for review with `review-race-crawl`.

`src/utils/races.ts` keeps a module cache that only holds the races the app
must resolve synchronously (`findEdition`): at boot `loadCatalogue` fetches the
editions the account refers to (participations, `targetEditionId`, the plan's
RACE sessions) plus its own contributions, races and dates added to
anyone's race alike (`listKnownRaces`), and every search
result is merged in (`rememberRaces`) so an edition picked from a search
resolves. **Failure-tolerant:** a failed fetch leaves the cache empty and the
app still renders (My Races falls back to participation snapshots); the boot
load is fired **unawaited** so a slow/down Supabase never blocks the splash.

## Curating the verified set

Curated rows (`created_by = null`, `verified = true`) change through data
migrations (`*_race_catalogue_*.sql`), so each pass is reviewable. Verifying
a user's contribution is a one-off SQL data fix, not a migration (see
"Contributions & Discover"). Rules:

- **Only officially announced dates.** Never add a next edition by bumping the
  year: that is how most bad dates got in (a guessed date lands on a weekday, or
  a week off). A race with no announced date shows "no upcoming date", which
  is honest. Check the weekday: road races are Sat/Sun (Boston is a Monday,
  ultras start any day, New Year's Eve races on the 31st).
- **Keep past editions**: they are what a completed participation points at.
- **Referenced editions are corrected in place.** A participation links by
  `editionId` (plus a snapshot of date/distance), so before deleting a wrong
  edition, check whether any `app_state.data->'rc_races'->'participations'`
  (or `rc_settings.targetEditionId`) references it; if so, keep the id and
  update `date` / `race_slug`. The user's snapshot and plan keep the old date,
  so tell them.
- **Start coordinates within ~300 m of the named start.** When the organiser
  names only the town or city, its centre point stands, whatever the place's
  size.
- **Scope:** any country a source covers (Mexico and Portugal included), and
  obstacle-course races (OCR) count as races.
- Edition inserts join `public.races`: most curated races were added outside
  migrations, so a fresh database simply skips them.
- The 2026-09-28 pass used official organiser sites wherever they resolved.
  Aggregators were used only where noted in the PR. Coordinates of added races
  are hand-placed near the named start (±300 m). An `elevation` of 0 means unknown.

New races and editions are found by the crawler (`docs/race-crawler.md`). It
adds only **unverified** rows (`created_by` null), so the "unverified" tag shows
until the `review-race-crawl` skill checks them against these same rules.

## Race page and goals

Tapping a race (Find, or a card in My Races) opens `RaceSheet`
(`src/modals/RaceSheet.tsx`): its dates and distances, a still map of the start
(`RaceMiniMap`, cached tiles), the official site (a button under the numbers, "Sign up" while the race has an upcoming date), and the runner's goal. The
goal box shows on the upcoming training target, or on a race not yet run whose
participation already carries a goal (clearing that goal removes the box); a race
only browsed shows none (Plan setup asks for the goal
when "Train for this race" builds the plan). A goal belongs to the participation
(`goalSec`, synced). The training target's goal stays `settings.goalSec`, mirrored
onto its participation (by `updateTargetGoal`, and for the outgoing target by
`promoteEdition`) so it survives the race no longer being the target. There the
field previews what the new goal does to the plan's paces (`paceChanges` over
the hub's `previewTargetGoal`, which builds the rebuild without saving it) and
"Update plan" applies it through `updateTargetGoal` (`rebuildPlanWith`, so
`carryProgress` keeps done/skipped) with an Undo. "Set as target" carries the
race's goal into Plan setup (`PlanPrefill.goalSec`). Suggestions come from
`predictRaceSec` (`src/utils/raceGoal.ts`): the same best-effort Riegel method
as Progress, over the last 84 days, grade-adjusted for the edition's climb. The
preview waits for a plausible goal (`isPlausibleGoal`, no faster than 2:30/km),
so a half-typed time builds nothing; `paceChanges` reads both plans from the
first week the rebuild wrote, past the `past-` week `carryProgress` keeps.

## Contributions & Discover

Contributions are instant + global + unverified. "Add a race"
(`src/modals/RaceFormModal.tsx`, opened via `shared.openRaceForm`) does a live
duplicate search and inserts `verified:false, created_by=uid`; the UI tags any
unverified race/edition. A new race needs a name, a date, a distance, a terrain and a
**country** (ISO 3166-1 alpha-2, normalised by `countryCode` in
`src/utils/country.ts`; `UK` becomes `GB`), and the `races_country_code` check
refuses a race without one. After a contribution, `refreshCatalogue`
(RunningCoach) re-fetches so it shows immediately.

**Near me** is a Find filter: a one-off `geoSource.getCurrentPosition()`
(web/native) sent coarse to `search_races`, which filters by radius and can sort
by distance. **km-only**; coordinates are never persisted or sent to telemetry. A race's own `lat`/`lng`
(so *other* users' Discover can find it) is set via `LocationPicker`
(`src/components/LocationPicker.tsx`) — a tap/drag Leaflet pin, **not** the
contributor's live GPS, since they're rarely standing where the race actually
happens. It opens centered on a one-off forward geocode (`src/utils/geocode.ts`,
MapTiler's geocoding endpoint — same `VITE_MAPTILER_KEY` as the tiles, already
covered by the CSP's `connect-src`) of the city/country already typed in the
form; "jump to my current location" is offered too, but only as one more way to
seed the pin, never the only option. Leaflet reports a point picked past the
antimeridian with a longitude outside ±180 (Napier as −183), so the picker
folds it back with `wrapLng` (`src/utils/geo.ts`), and `races_coordinate_bounds`
refuses an out-of-range pin.

## Moderation

`reportRace` writes a `race_reports` row (insert-only RLS, no client SELECT —
so insert WITHOUT `.select()`, using a client-generated id for notification
lookup) and best-effort invokes the `notify-contribution` edge function
(`supabase/functions/`), which emails the maintainer + thanks the contributor
via AWS SES (SigV4-signed with `aws4fetch`; keys in
`SES_AWS_ACCESS_KEY_ID`/`SES_AWS_SECRET_ACCESS_KEY`, optional
`SES_REGION`/`FROM_EMAIL`/`MAINTAINER_EMAIL`; degrades to a no-op if unset, and
without `MAINTAINER_EMAIL` only the maintainer notice is skipped).
`notify-contribution` must only send from validated DB rows owned by the caller
and dedupes in `contribution_notifications`; callers pass stable row ids
(`raceSlug`, `editionId`, `reportId`, `feedbackId`), not arbitrary email
bodies. The "verified → thank-you" half is in-app: `reconcileVerifiedThanks`
(RunningCoach) toasts once when a maintainer verifies the user's own
contribution. Reviewing and verifying a contribution (plain SQL, no migration,
then a Gmail note to the contributor) is the `validate-contribution` skill
(`.claude/skills/validate-contribution/`).

## Personal layer (synced blob)

Lives in the blob under `STORAGE_KEYS.RACES` (`rc_races`), NOT in the
catalogue: `{participations:[...], seenBadges:[...], ackVerified:[...]}`
(`ackVerified` = which of the user's verified contributions we've already
thanked them for). A participation snapshots `label/raceDate/distanceKm`
alongside the `editionId` so a wishlist entry survives if the catalogue edition
disappears (orphan tolerance). It's in the synced blob, so it's covered by
backup/restore (add to both when extending) — the shared catalogue is NOT
exported.

Not in the blob, on purpose: whether the runner joined a race's field of app
runners, and their public name. Those are server-side consent
(`race_field_members`, `profiles.public_name`), never exported or restored
(`docs/race-field.md`).

## Training target & multi-race plans

`settings.targetEditionId` marks which edition the plan was built from
("Training target", one only). Promote via `promoteEdition`
(`RunningCoach.tsx`) → prefills PlanView's setup; the plan is built there
(reusing `buildPlan`), which sets `targetEditionId`. Hand-editing the race in
PlanView **clears** it (decouple).

Multi-race plans have no user-facing priority: the plan peaks/tapers for the
**main** race; other races the user flags with `participation.inPlan` are
folded in as RACE sessions (id `race-{editionId}`) by `buildPlan` when before
the target and inside the window. A *substantial* secondary race (≥ half the
main distance) auto-gets a mini-taper week; a small one just drops in — the
user picks nothing (no A/B/C). Toggling a race in/out goes through
`setRaceInPlan` (`RunningCoach.tsx`), which rebuilds the plan **preserving
done/skipped by session id** (`carryProgress`) so progress isn't wiped. Every
RACE session is stamped with its `editionId`; race-day auto-detect
(`detectAnyRace` in `src/utils/races.ts`) matches a logged run against **all**
plan races, not just the target.

## Catalogue date changes

A participation snapshots its date, and the training target lives on in
`settings.raceDate` and the plan, so a corrected catalogue date never reaches
them on its own. `raceDateChanges` (`src/utils/races.ts`) is the one detector:
pure over the fetched catalogue, it lists wishlisted races (and the target,
compared against `settings.raceDate`) whose edition date differs, skipping
done races, races past on both dates, and dates in `RacesState.dateAcks`.
`RaceDateChangeCard` shows each on Home and My Races with two answers:
**Update** (`applyRaceDateChange`: moves the participation and, for the target,
`settings.raceDate`; rebuilds the plan through `carryProgress` when the race is
the target or `inPlan`; undoable) or **Keep my date** (`keepRaceDate` records
the catalogue date in `dateAcks`, so only a *further* move asks again). Never
move a user's date silently: the catalogue is community-editable.

## Completion

Three ways to complete a race, all settling the same two things: the
participation (catalogue races only) and the plan's RACE session.

- **Auto-detect.** A saved run on a plan race's date within ±18% of its
  distance triggers an undoable toast. The pure logic is
  `detectRaceCompletion` (`src/utils/raceCompletion.ts`); its candidates are
  every RACE session on the plan (the main race first, secondary ones after),
  the settings target for plans built before sessions carried an edition, and
  the wishlist in race-day mode. A match ticks the RACE session with
  `linkSess` (not re-dated: the race happened on its own day) and, when the
  candidate has an `editionId`, marks the participation done. A **hand-entered
  race** has no edition, so only the session is ticked, with the neutral
  `app.toasts.yourRace` label and **no confetti** (`isMain` stays
  catalogue-only). Undo reverses both. Something already settled is never
  marked twice. `sessionMatch`'s `isOpen` stays RACE-blind on purpose: a race is
  never "the run you did on Wednesday".
- **The debrief** (Home, `DebriefCard`): after the race, "How did it go?" names
  the run (`raceRunCandidates`, race day ±1, unclaimed, running only, through
  `ReconcileSheet`) or sends the runner to the log; "Didn't run it" skips. Both
  go through the hub's `settleRace` / `skipRace`, which write the session and
  the participation together under one Undo. A settled race on a plan written
  with a recovery then moves Home to the recovery card and its "Sore or
  injured?" row, until the window ends. See `docs/training-plan.md` ("Where the
  runner stands", "Recovery after the race"). The same race is what
  `recentRace` hands the next plan build, so a rebuild within two weeks opens
  inside that recovery.
- **Manual "log result"** (RacesView, optionally also adds a RACE run via
  `addRuns(..., {skipDetect:true})`, with no effort: `null`, never a guess). For the plan's
  main race it delegates to `settleRace` so the RACE session is ticked too.

`status: "skipped"` ("Didn't run") is a real participation state: it lists with
the past races and still offers "Add your time".

## What's next?

`WhatsNextSheet` (`src/modals/WhatsNextSheet.tsx`, logic in
`src/utils/whatsNext.ts`) is the one screen for choosing what to train for after
a race. It only collects an answer; the hub's `startNextGoal` acts on it.

- **Steps.** A recap of the **training block** (not the race: sessions done of
  planned, distance, longest run and the easy-pace trend, from the plan's weeks
  up to the day before race day, the race run left out; an open plan's recap is
  its last four weeks; `src/utils/blockRecap.ts`, rendered by
  `components/BlockRecap.tsx`, below) -> "How are you feeling about running?" (fired up / steady / need a
  breather; there is no pause mode) -> the goals in the order the answer
  suggests: fired up: next race, keep improving; steady: keep improving, next
  race; need a breather: a lighter plan (about 2 easy runs a week), keep
  improving. A runner already on blocks of their own sees the race option as
  "Try a real race".
- **The recap's easy pace** claims no more than the log supports. It compares
  the median pace of the block's EASY runs at its start and at its end (the first
  and last 3 pre-taper weeks, fewer on a short block: each end spans half the
  block at most and the block needs 4 pre-taper weeks), grade-adjusted like the
  HR fit (`flatEqKm`). Each end needs 3 easy runs, else the line is hidden. When
  3+ runs at each end carry a heart rate (and max HR is known) every pace is
  moved to the block's median HR on the prior slope (`PRIOR_PACE_PER_RESERVE`,
  `docs/race-predictions.md`), so a run that was only harder does not read as
  fitness, and the line says "at the same heart rate, about N bpm". Without
  that it is the plain median and the copy makes no same-effort claim. After an
  open plan's checkpoint run Home also shows a "Block n done" row
  (`finishedBlock`, `BlockDoneCard`) with the same numbers for
  `BLOCK_DONE_DAYS` (10). Free: a one-moment summary, not a history surface
  (`docs/monetization.md`).
- **Next race** leads with a wishlisted race at least 3 weeks out, else the
  catalogue's top 3 (6-24 weeks out, near the distance just raced, soonest
  first, nearest first once "Near me" has a fix, `useNearMeFilter`); each opens
  `promoteEdition`, so the plan is built in Plan setup as ever. **Keep
  improving** (fr "Progresser", es "Seguir mejorando") has the target chips:
  faster at 5K/10K/half (each showing the runner's best effort), run further,
  stay healthy and consistent. No "run more often".
- **Applying** an open choice: `startNextGoal` writes the settings
  (`openSettingsPatch`: `goalKind`, `openTarget`, `lightPlan`, no race date or
  target), builds the open plan over the old one through `carryProgress` (with
  `afterRace`) and toasts an Undo.
- **When it shows.** By itself on Home when the phase is `choosing`,
  `settings.whatsNextFor` is not the race's key (`raceKey`: edition id and
  date), the race (plus its recovery) is at most 28 days back, and nothing else
  is up (achievement sheet, coachmark, recorder, settings, other sheets).
  **Any answer spends it**, "Not now" and back/Escape included
  (`whatsNextFor` is written). Afterwards the quiet row (`NextGoalCard`, and
  PlanView's "Set your next goal") opens it by hand; so does the coach's
  `app:next`.
- **Race-first variant** (race-day mode). A live-first runner's race, detected
  on race day with `raceBridgeSeen === false`, opens the same sheet with no
  recap and no question and races first (`RaceBridgeSheet` is gone); any answer
  sets `raceBridgeSeen`. Spent after the post-run achievement sheet, never
  stacked on it.
- A runner who never answers gets the automatic start in
  `docs/training-plan.md` ("Open plans and blocks").

## Badges

**Pure & derived** (`computeBadges(runs, participations)` in
`src/utils/badges.ts`) — never stored except `seenBadges`. Reconcile in event
handlers, NOT an effect (the `react-hooks` rule forbids sync setState in
effects): `reconcileBadges` seeds `seenBadges` silently on first run, then
toasts only new unlocks. Icons are lucide *names* mapped in `Badge.tsx` to keep
`badges.ts` React-free/testable. Tone is gentle: cumulative active-weeks (not
fragile streaks) and WALK counts.
