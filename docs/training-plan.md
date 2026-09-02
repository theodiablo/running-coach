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

It only ever **proposes**. Two surfaces apply it, both by a confirmed tap:

- **At save time** (`offeredSession` in `RunningCoach`, rendered by `LogView`).
  A recorder's hand-off carries an `offered` session in the prefill — distinct
  from `wNum`/`sId`, which mean the runner already chose it and there is nothing
  to confirm. The offer shows above the Save button with its own date and a
  "Not this one" that saves the run alone. `offered` is not run data:
  `carryPrefill` drops it.
- **After the fact** (`ReconcileSheet`, from the next-session card's "I already
  ran this"). Ranked candidates, best preselected, nothing applied until
  "Count it".

Both land in `linkSess`, which sets `done` **and** `runId` in one write, and
optionally re-dates the session to the day the run happened — the plan's dates
feed the coach and the load rules, so a tempo left dated Thursday that the legs
did on Wednesday misstates recovery. The move is only offered when the day falls
inside the session's own plan week (`canMoveSessionTo`); outside it the session
would be filed under a week it no longer falls in.

Undo is **not** the same call again the way `toggleSess`/`skipSess` are: it has
to release the run and put back the original date (`unlinkSess`). For the same
reason, unticking a session anywhere clears its `runId` — otherwise the run
stays invisible to every other session's candidate list.

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
