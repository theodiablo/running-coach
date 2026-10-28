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
signup can't flood every client's catalogue download. `src/races.ts` is the access module (mirrors
`src/routes.ts`: direct queries — `listRaces`/`addRace`/`addEdition`/
`reportRace`). `notifyContribution` (the best-effort maintainer-email trigger)
lives in `src/notify.ts` — generic, not race-specific, so other
contribution-shaped writes (e.g. coach feedback) reuse it without importing a
races module.

Keep ALL catalogue lookups going through `src/utils/races.ts` (`findEdition`,
`searchEditions`), which holds the fetched catalogue in a module cache
(`hydrateCatalogue`) loaded once at boot by `loadCatalogue`.
**Failure-tolerant:** a failed fetch leaves the cache `[]` and the app still
renders (My Races falls back to participation snapshots); the boot load is
fired **unawaited** so a slow/down Supabase never blocks the splash.

## Curating the verified set

Curated rows (`created_by = null`, `verified = true`) change through data
migrations (`*_race_catalogue_*.sql`), so each pass is reviewable. Rules:

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
- Edition inserts join `public.races`: most curated races were added outside
  migrations, so a fresh database simply skips them.
- The 2026-09-28 pass used official organiser sites wherever they resolved.
  Aggregators were used only where noted in the PR. Coordinates of added races
  are hand-placed near the named start (±300 m). An `elevation` of 0 means unknown.

## Contributions & Discover

Contributions are instant + global + unverified. "Add a race"
(`src/modals/RaceFormModal.tsx`, opened via `shared.openRaceForm`) does a live
duplicate search and inserts `verified:false, created_by=uid`; the UI tags any
unverified race/edition. After a contribution, `refreshCatalogue`
(RunningCoach) re-fetches so it shows immediately.

**Discover** is a RacesView segment: one-off `geoSource.getCurrentPosition()`
(web/native), sort by `haversineM`, distance-band + radius chips. **km-only**;
coordinates are never persisted or sent to telemetry. A race's own `lat`/`lng`
(so *other* users' Discover can find it) is set via `LocationPicker`
(`src/components/LocationPicker.tsx`) — a tap/drag Leaflet pin, **not** the
contributor's live GPS, since they're rarely standing where the race actually
happens. It opens centered on a one-off forward geocode (`src/utils/geocode.ts`,
MapTiler's geocoding endpoint — same `VITE_MAPTILER_KEY` as the tiles, already
covered by the CSP's `connect-src`) of the city/country already typed in the
form; "jump to my current location" is offered too, but only as one more way to
seed the pin, never the only option.

## Moderation

`reportRace` writes a `race_reports` row (insert-only RLS, no client SELECT —
so insert WITHOUT `.select()`, using a client-generated id for notification
lookup) and best-effort invokes the `notify-contribution` edge function
(`supabase/functions/`), which emails the maintainer + thanks the contributor
via AWS SES (SigV4-signed with `aws4fetch`; keys in
`SES_AWS_ACCESS_KEY_ID`/`SES_AWS_SECRET_ACCESS_KEY`, optional
`SES_REGION`/`FROM_EMAIL`/`MAINTAINER_EMAIL`; degrades to a no-op if unset).
`notify-contribution` must only send from validated DB rows owned by the caller
and dedupes in `contribution_notifications`; callers pass stable row ids
(`raceSlug`, `editionId`, `reportId`, `feedbackId`), not arbitrary email
bodies. The "verified → thank-you" half is in-app: `reconcileVerifiedThanks`
(RunningCoach) toasts once when a maintainer verifies the user's own
contribution.

## Personal layer (synced blob)

Lives in the blob under `STORAGE_KEYS.RACES` (`rc_races`), NOT in the
catalogue: `{participations:[...], seenBadges:[...], ackVerified:[...]}`
(`ackVerified` = which of the user's verified contributions we've already
thanked them for). A participation snapshots `label/raceDate/distanceKm`
alongside the `editionId` so a wishlist entry survives if the catalogue edition
disappears (orphan tolerance). It's in the synced blob, so it's covered by
backup/restore (add to both when extending) — the shared catalogue is NOT
exported.

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
  planned, distance, longest run, from the plan's weeks up to the day before
  race day, the race run left out; an open plan's recap is its last four
  weeks) -> "How are you feeling about running?" (fired up / steady / need a
  breather; there is no pause mode) -> the goals in the order the answer
  suggests: fired up: next race, keep improving; steady: keep improving, next
  race; need a breather: a lighter plan (about 2 easy runs a week), keep
  improving. A runner already on blocks of their own sees the race option as
  "Try a real race". Step 4 adds an easy-pace trend to the recap.
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
