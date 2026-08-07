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
only the service role does). `src/races.ts` is the access module (mirrors
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

## Completion

Two ways to complete: manual "log result" (RacesView, optionally also adds a
RACE run via `addRuns(..., {skipDetect:true})`), or **auto-detect** — a saved
run on `settings.raceDate` within ±18% of the target distance triggers an
undoable "mark done" toast (`detectAnyRace` + `detectCompletion` in
`RunningCoach.tsx`), which matches against every race on the plan.

## Badges

**Pure & derived** (`computeBadges(runs, participations)` in
`src/utils/badges.ts`) — never stored except `seenBadges`. Reconcile in event
handlers, NOT an effect (the `react-hooks` rule forbids sync setState in
effects): `reconcileBadges` seeds `seenBadges` silently on first run, then
toasts only new unlocks. Icons are lucide *names* mapped in `Badge.tsx` to keep
`badges.ts` React-free/testable. Tone is gentle: cumulative active-weeks (not
fragile streaks) and WALK counts.
