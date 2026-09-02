# Training plan generation

How `buildPlan` composes plans: opts, methodology styles, fitness signal, and
multi-race overlays. Moved out of CLAUDE.md; keep this current when touching
`src/utils/plan.ts` or `src/utils/planStyles.ts`. Multi-race/target wiring is
in `docs/races.md`; the coach agent (which edits but never authors plans) in
`docs/coach-agent.md`.

## buildPlan & its opts

`settings` is the central config object (race fields, HR profile,
`planSessions`, `name`, `onboarded`). The plan is (re)built by
`buildPlan(raceDate, goalSec, planSessions, distanceKm, raceElevation, opts)`
(`src/utils/plan.ts`). The `opts` object is additive (positional call sites
keep working): `recentRuns` seeds a **fitness-aware** BASE start (longest run
in the last ~5 weeks, clamped to the race-scaled peak) so a fit athlete isn't
reset to a tiny long run; `mainEditionId` + `races` drive the secondary-race
overlay (see `docs/races.md`).

The long run is scaled to **race distance** (~0.9× for ≤half, ~30-32 km
marathon, ≤36 km ceiling for ultras), NOT capped by the long-session minutes —
so it can exceed the configured long-day duration; PlanView shows an honest
nudge when it does. `plan.longRunPeakKm` exposes the peak for that nudge.

## Rebuilds and retained history

`buildPlan` always anchors week 1 on the **next Monday**, so a rebuilt plan
contains no already-elapsed date. That makes `carryProgress(old, new, "rebuild")`
(the one merge point for every rebuild — availability edit, goal change, race
add/remove) do two jobs:

- **Prepend what the rebuild cannot reach.** Every old week that has already
  begun and starts before the new plan's first Monday is carried **verbatim**
  and kept in `plan.weeks`, capped at the trailing `KEEP_HISTORY_WEEKS` (8).
  Without it every completed session before that Monday simply disappeared —
  "completed runs stay" had quietly stopped being true. The cut is the new
  plan's start rather than today on purpose: it also keeps the **part-run
  current week**, so a Wednesday rebuild doesn't leave the runner with no
  sessions until Monday. Contiguous by construction — no gap, no day claimed
  twice. Retained session ids are prefixed `past-` (buildPlan mints `w1d2`
  every time; a collision is a `DUPLICATE_ID` validator error and a duplicate
  React key), and weeks are renumbered 1..n across the join so "week n of m",
  `overdueByWeek` keys and the coach's `week_number` tools stay coherent.
- **Re-stamp flags by calendar date** onto the newly built weeks — never by
  session id, which names a *slot* (`w{n}d{dOff}`), not a day. See the comment
  block in `carryProgress`; matching on ids once transplanted a month of
  done/skipped onto sessions the runner had never seen.

`"coach"` mode is the exception that still matches by id: a coach proposal is
derived from the live plan, so ids *are* identity there.

A **promote** (switching the plan to a different race) deliberately carries
nothing at all — it is a fresh plan for a new goal.

Elapsed weeks are a real distinction downstream: `isElapsedWeek`
(`src/utils/plan.ts`, with a date-string twin in
`supabase/functions/_shared/coach/weeks.mjs`) is the single definition, read by
PlanView's ordering, the overdue lookback (`docs/reminders.md`) and the coach's
validator/tools/context (`docs/coach-agent.md`).

## Linking a run to the session it settled

`PlanSession.runId` names the run that settled a session — for a long time it
was minted `null`, carried by `carryProgress`, and never written. Until it was,
"done" was a boolean with no evidence behind it, and the only way a run met a
session was `findOpenPlanSession`: same calendar day, at the single moment a
recorder handed off to the log form. Do Thursday's tempo on Wednesday and the
two never met — the session stayed untickable (the Dashboard tick is gated to
today-or-past, correctly: ungated it walked forward through the plan) and the
run stayed anonymous.

`src/utils/sessionMatch.ts` is the one matcher, pure and shared by both entry
points. A run is a candidate for a session when it is within
`MATCH_WINDOW_DAYS` (3) either side, agrees on `isCrossTraining` (a bike ride
must never tick off a tempo, and vice versa), and is not already some other
session's `runId` — **one run settles one session**. Candidates rank by day gap
first, then by how close the distance is to the prescription, then by recency.

`bestSessionForRun` is stricter than `candidateRuns` on purpose: it is shown
already accepted, so a **cross-day** guess must also land within
`CROSS_DAY_KM_TOLERANCE` of the prescription. A recorder cannot corroborate the
guess with the type — the GPS tracker saves every run as `EASY`, because it has
no idea what you were doing — so distance is the only signal it has, and without
the check a 5 km jog arrived offering to tick off Thursday's 12 km intervals.
Same-day matches are exempt: the day already says which session you meant, which
is the pre-existing `findOpenPlanSession` behaviour. The sheet's list is picked
from by a human and needs no such corroboration.

It only ever **proposes**. Two surfaces apply it, both by a confirmed tap:

- **At save time** (`offeredSession` in `RunningCoach`, rendered by `LogView`).
  Every hand-off carries the session as a **whole row** (`prefill.session`) plus
  `sessionOffered`, which says whether the app matched it or the runner chose
  it; an offer gets a "Not this one" that saves the run alone. The row rather
  than a bare `{wNum, sId}` because **the form re-checks the pairing against
  what the runner types**: `runFitsSession(session, f)` is read at render, so
  changing the type to Other or the date out of the window drops the link and
  says so, instead of the save quietly ticking a tempo off with a bike ride.
  Neither field is run data — `carryPrefill` drops both. Note the row carries
  cross-training's *synthetic* km (`buildPlan` mints one to satisfy the coach
  validator), so anything reading it for display must go through
  `isCrossTraining` first.
- **After the fact** (`ReconcileSheet`, from the next-session card's "I already
  ran this" and from an overdue row's link button — the same case one day
  later, whose only other action is the evidence-free tick this replaces).
  Ranked candidates, best preselected, nothing applied until "Count it".

Both land in `linkSess`, which sets `done` **and** `runId` in one write, and
optionally re-dates the session to the day the run happened — the plan's dates
feed the coach and the load rules, so a tempo left dated Thursday that the legs
did on Wednesday misstates recovery. The move is only offered when the day falls
inside the session's own plan week (`canMoveSessionTo`); outside it the session
would be filed under a week it no longer falls in.

Undo is **not** the same call again the way `toggleSess`/`skipSess` are: it has
to release the run and put back the original date (`unlinkSess`).

**A `runId` must never outlive the thing it points at, and never outlive its own
`done`.** A session left `{done: false, runId: "r1"}` reads as untouched
everywhere, while r1 stays claimed and is therefore offered to no session at all
— not even that one, with nothing on screen to explain why. So: unticking or
skipping clears `runId`; `deleteRun` calls `releaseRun` to drop every claim on
the run it removes; and `carryProgress` nulls `runId` on any session whose
`done` it drops for being past `DONE_LOOKAHEAD_DAYS`. The week-containment rule
for a re-date lives in `linkSess` itself, not only in the sheet that offers the
move.

## Methodology styles

`opts.style` / `settings.planStyle` / `plan.style`: buildPlan composes weeks
per style — `balanced` (default; the pre-styles algorithm, frozen
byte-identical by snapshot tests in `plan.test.ts` — absent/unknown style
resolves to it), `polarized`, `runwalk`, `lowfreq`, `hansons`.

**Pace multipliers live in `supabase/functions/_shared/coach/styles.mjs`**
(single source shared with the coach agent's `tools.mjs`; app re-export
`src/utils/planStyles.ts` — never hardcode the ratios elsewhere); plan shape
(long-run peak/taper/cutbacks), `STYLE_META` blurbs and the pure
`recommendStyle` profile heuristic are app-side in `planStyles.ts`. New styles
must stay validator-clean **by construction** (space hard days via
`pickHardDays`; buildPlan's adjacency sweep demotes stragglers to EASY —
balanced is exempt to preserve its output) — the matrix in
`coachValidation.test.ts` enforces this across distances/day layouts.

The UI seam is `StylePicker` (PlanView setup/edit + both onboarding branches):
selection state is `StyleId | null` where null = "untouched, track the live
recommendation"; a tap pins it. All buildPlan call sites must pass
`style: settings.planStyle` (or the draft) — a missed site silently rebuilds
as balanced.

## Fitness signal & suggested days

`settings.trainingLevel` (`"none"|"occasional"|"regular"|"frequent"`, synced)
is onboarding's one-question self-report ("How much do you run right now?",
`LevelTiles` in both branches, optional). It substitutes for run history ONLY
when none exists: `recommendStyle` maps it to a synthetic weekly-km band (real
logged runs always win) and `buildPlan`'s `opts.level` floors the starting long
run (`levelStartLongKm`, capped at the race peak).

`suggestPlanSessions(distance, level)` (`planStyles.ts`) provides default
training days — minutes must come from `SessionConfigurator`'s fixed option
set, the Sunday session strictly longest, quality days ≥2 from Sunday so
`pickHardDays` places without demotions. Onboarding uses the same
null-=-tracking pattern as the style (the stock Wed30/Sun60 default counts as
untouched); PlanView offers it as a "Use suggested days" one-tap fill, never
overriding a configured draft.
