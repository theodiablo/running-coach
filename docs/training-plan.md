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

## Phases

Each week carries a `phase` (`BASE` · `BUILD` · `PEAK` · `TAPER` · `RACE` ·
`RECOVERY`, the last only on plans built with a recovery) that
PlanView shows as the week's badge, so **the label is a promise about the
week's sessions** and the two are derived from one set of boundaries in
`buildPlan`:

- **taper** = the last 3 weeks before race week (easy only — the validator also
  forbids tempo/intervals inside 7 days of the race). The week's shed
  multiplier is the style's own `taperMults` ladder, handed to the composers as
  `WeekCtx.taperMult` so long run and short days shed on one ladder. **Every
  tapered session scales off its own pre-taper peak, never an absolute km
  ladder** — an absolute one ignores how small the ramp actually stayed, and on
  a short or base-credited block `runwalk` raised its short days *above* their
  peak, making the first taper week the biggest of the plan (`TAPER_VOLUME`).
- **base** = the first `min(4, ceil((N-3)/2))` weeks *minus the runner's base
  credit* (below): easy running only, no quality. Capping it at *half the
  pre-taper runway* is what keeps a short plan honest — from 11 weeks up it is
  the fixed 4 it always was.
- **peak** = the last 4 pre-taper weeks (never earlier than the end of base);
  **build** fills any gap between base and peak.

### The easy-day floor

The long run has always had a fitness floor; the easy days did not. They opened
at an absolute `2.5 + 0.2 x week` km whatever the runner had been doing, so
someone already running 8-9 km easy — against a 45-minute session budget they
had configured themselves — was prescribed 15-minute jogs, and read the whole
plan as not worth following.

`easyFloor` is that missing twin. It is the **median** distance of the running
runs in the same ~5-week window `fitFloor` uses, with the same `0.8` haircut. It
does not replace each style's easy line — it sets where that line **starts**,
via the shared `easyLine` helper:

```ts
Math.min(budgetKm, Math.max(start + step * week, Math.min(c.easyFloor, longKm * 0.85)))
```

so the per-week growth each style already had (`+0.2/wk` in base, `+0.3/wk` for
polarized's build days, `+0.25/wk` for runwalk) survives on top of it. Three
guards keep it honest:

- **Median, not max** — one big Sunday effort is not what the runner does on a
  Tuesday.
- **At least 3 runs in the window**, or the floor is 0 and the line is exactly
  what it was. One or two runs in five weeks is a sample, not a habit; the long
  run's single-sample floor is defensible in a way a habitual easy distance is
  not. This is also why the balanced output freeze still holds — its fixture
  logs a single run.
- **The long-run cap bounds the FLOOR, not the whole line.** It is capped
  against `longKm` of the week being composed — a cutback week (runwalk sheds
  30% every third) drops below a block-level cap, which is how a WALK day
  overtook the long run it was meant to sit under. But applying that ceiling to
  the style's own opening line as well *shrank* plans that have no floor at all:
  an unfit runner's long run is small, so `0.85x` of it undercut the 2.5 km
  opening, left the taper nothing to shed, and tripped `TAPER_VOLUME`. Hence
  `Math.max(line, Math.min(easyFloor, longKm * 0.85))` — with `easyFloor` at 0
  the whole expression collapses to the style's own line, byte-for-byte.
  The day's own time budget is the other ceiling, so the runner's configured
  minutes still win.
- **`week` and `longKm` are overridable** because runwalk's taper needs them:
  since #246 the short days shed off the last pre-taper week on the same
  `taperMult` ladder as the long run, so that branch evaluates the line at week
  `N-4` against `peakLong` (recoverable in a taper week as `longKm / taperMult`)
  and then applies the multiplier.

**With no logged habit, the self-reported level stands in** — the same way
`levelStartLongKm` stands in for the long run. `levelEasyKm`
(`planStyles.ts`) derives it from `LEVEL_PROFILE`:
`0.8 x (weeklyKm - startLongKm) / max(1, runCount - 1)`, kept monotonic across
levels (more running days never means shorter easy days): occasional 3.2 km,
regular and frequent 6.8; `none`/absent is 0. It feeds the same `easyFloor`
slot only when the window holds fewer than 3 runs, so logged runs always win,
and the same `easyLine` caps (week's long run, day's time budget) apply — a
level never prescribes more than the runner's own configured minutes. Without
it a signup 17 days from a half marathon opened on four 2.5 km jogs next to a
long run several times that, and left.

Which weeks it reaches is per style, and follows where each style's easy line
already lived: base only for balanced and lowfreq; base **and build** for
polarized (whose build-phase non-hard days are on the same growth line); every
non-taper week for runwalk (which has no quality days to displace). Taper weeks
keep their own shrinking line untouched in every style — shedding volume is what
a taper is for. Hansons is the exception in shape: it already ramped toward the
time budget rather than sitting on a constant, so the floor raises where that
ramp starts, capped at `0.6 x` the budget so there is always a climb left to
make — cumulative fatigue is built by the climb, not by opening at the ceiling.

### The base credit

The base block is the **phase-block twin of the long run's fitness floor**.
`buildPlan` always re-anchors week 1 on the next Monday, so without a fitness
signal a runner who adds a race mid-training is marched back through a base
block they have just run — four weeks of easy-only work they had already
finished. `baseCredit` reads the same `recentRuns` the long-run floor does and
shortens the on-ramp:

| Trained weeks (of the last 4) | Weeks credited |
| --- | --- |
| 0–1 | 0 — a new or returning runner gets the full block |
| 2 | 1 |
| 3–4 | 2 |

A **trained week** is a 7-day window holding runs on ≥2 separate days *and* at
least as much running as the plan's own opening week would ask (`startLong +
2.5 km` per other session — the long run's fitness-aware start plus the base
easy line). Both halves are load-bearing: counting entries alone, two 2 km jogs
a week bought a runner out of the on-ramp they most needed, and two runs on one
day is a keen day, not a week of training. Only running counts — cross-training
builds fitness but not the running base (same `isCrossTraining` line as the
long-run floor). Windows are walked by calendar date, not fixed milliseconds, or
a DST change slides the whole grid a day.

The ladder is deliberately coarse and capped at 2 — evidence of consistency
shortens the on-ramp, it does not hand a fit runner a plan that is all quality;
a 16-week block still opens with base weeks, and every plan with more than one
pre-taper week keeps at least one. Self-reported `level` deliberately does
**not** feed this: it floors the long run, but only logged runs buy a shorter
base.

### The ramp guard

Shortening the base block moves quality onto a smaller week, and a quality
session is sized off the day's *time budget* while the easy day it replaces is
on the base's gentle km line — a real jump in weekly volume. `buildPlan` closes
with a guard that applies the validator's own ramp rule (`1.3 ×` the bigger of
the two preceding weeks, `+3 km`) to its own output: a week over the line sheds
distance from its quality sessions, longest first, never from the long run,
which is the week's point. Intervals stop one rep short of disagreeing with
their own description; distances are shaved in whole tenths, because rounding a
just-enough cut back up leaves the week over the line it just cleared.

A plan already inside the rule comes through byte-identical, so the guard is
invisible to every clean plan — including the frozen snapshots. It is what
keeps "generated plans are validator-clean by construction" true now that
quality can start in week 2; it also cleans up a number of pre-existing
short-horizon plans that were dirty before it existed. It does **not** touch
`HARD_BACK_TO_BACK`: for `balanced`, a user-picked adjacent day pair is a
pre-existing, validator-waived condition the generator must not silently
rewrite (see the demotion sweep's exemption), and short plans can now reach it
because they finally have quality sessions to place.

The composers read `isBase`/`isTaper`/`phase` from those same boundaries, and
`buildW` (the week's index *within the post-base block*) drives the
tempo/intervals alternation — so quality work starts exactly when the label
says BUILD/PEAK. A previous split definition (base fixed at `w < 4`, peak at
`w >= N-7`, peak tested first) labelled the easy base weeks of every plan
shorter than 11 weeks `PEAK`, and an 8-week plan reached its taper having
prescribed a single quality week. `runwalk` is the one style with no
tempo/intervals by design; its phase still moves the run/walk ratio.

## Recovery after the race

A plan built with `opts.recovery` (every app call site passes it) carries the
easy days after its race, so the plan no longer ends on a finish line with
nothing behind it. **Plans already running have none**, and get no derived
recovery phase either: they go from debrief to choosing as before. Recovery
exists only for plans built with it.

- **The rules** (`RECOVERY_RULES`, `_shared/coach/recovery.mjs`, app re-export
  `src/utils/recovery.ts`), by distance raced: up to 7.5 km 4 days with 1 rest
  day; up to 16 km 6 with 2; up to 30 km 12 with 2; up to 45 km 21 with 3;
  beyond, 26 with 4. The days count from race day, the first `rest` of them
  carry no session, and `until` (inclusive) is race day plus the days.
- **The tail.** Only the **main** race gets one (secondary races keep the plan's
  own sessions). Sessions land on the runner's `planSessions` weekdays between
  `race + rest + 1` and `until`: days still in the race week go into the RACE
  week, later ones into Monday-anchored `RECOVERY` weeks. No tail when the race
  sits outside its race week (a race closer than the 4-week floor, or past the
  24-week cap). They are EASY with `sd: {kind: "recovery"}`; Run/Walk uses WALK
  at the BASE-phase ratio (`runwalkRunSec`, so never past the runner's ceiling);
  low-frequency keeps its non-key days as OTHER. Never TEMPO, INTERVALS or LONG.
  Distance is the median EASY/WALK day of the last TAPER week (3 km when there is
  none) times a factor ramping 0.6 to 0.9, clamped to 1.5-8 km and to the day's
  time budget. Ids are slot-shaped (`w{n}d{off}`), so `carryProgress` matches
  them by date. `plan.recovery = {race, km, until}` is stamped, a build-time
  fact like `raceDate`; the phase stays derived.
- **A plan opened right after a race** (`opts.afterRace = {date, km}`, from
  `recentRace`: the main race settled done, a done participation or a RACE run of
  3 km or more, within the 14 days before today). If that race's `until` reaches
  the next Monday the plan opens with whole `RECOVERY` weeks (`k` of them), the
  training anchor shifts by `7k` and weeks and slot ids are renumbered; the
  ramp guard never sees them. Over 16 km the first training week turns its
  TEMPO/INTERVALS into EASY (distances unchanged). The race run itself is
  dropped from the fitness floors and the base credit. `plan.openedAfter`
  mirrors `plan.recovery` while the window is still running.
- **Goals** gain `plan.goal?: {kind: "race" | "block" | "open"}`; absent means
  `"race"` (`goalKind`). Open plans write it ("Open plans and blocks" below).
- **One date rule.** `canHoldTraining(plan, date)` (before race day always, race
  day never, after it only from the day past the rule's `rest` days through
  `recovery.until`; any other goal kind always)
  decides AFTER_RACE in the validator, `canPlaceOn` in `planEdit` and the coach
  tools; `inRecovery` marks the easy-only days (the two windows plus `RECOVERY`
  weeks) for `RECOVERY_HARD` and the tools' refusals.
- **Surfaces.** `planPhase` gains `recovery` (see below); Home shows
  `RecoveryCard` in the race slot while it runs, with the next-session card
  unchanged beneath. "Sore or injured?" appears whenever a window is running
  (debrief included): `RecoverySoreSheet` offers `lightenRecovery`
  (`planEdit.ts`: untouched recovery sessions ahead x0.6, floor 1.5 km, with an
  Undo toast) or the coach (`openCoach(null, "recovery")`), and a one-line
  caveat to see a professional for sharp or lasting pain. PlanView counts
  "week n of m" through the race week.

## Open plans and blocks

Not every runner trains for a race, and a plan that ends on a finish line they
never chose is the wrong shape for them. A plan with `plan.goal.kind` `"open"`
("Keep improving") or `"block"` (a fitness runner's first blocks; the same
engine, different copy and telemetry) has **no race date**: `plan.raceDate` and
`settings.raceDate` are `""`, nothing in it is a RACE session of its own, and
there is no taper and no recovery tail. **`goal.kind` absent means race**, and
every reader of `settings.raceDate` tolerates `""`.

- **Shape.** `buildPlan("", goalSec || "", planSessions, distanceKm, 0,
  {goal: {kind, target, light}, blockOffset, ...})` is the same function as for
  a race (one author), taking a branch only when `opts.goal.kind` is not
  `race`; the race path, `balanced` snapshots included, is byte-identical.
  Two 4-week **blocks** are built from the next Monday (`8 - blockOffset % 4`
  weeks). Weeks 1-3 ramp the long run; week 4 is a cutback (long run x0.8)
  whose long-run slot is the **checkpoint**. The goal is stamped on the plan:
  `{kind, target, distanceKm, light?, blockWeeks: 4, startDate, paceSource,
  autoFor?, extendedThrough?}` (`startDate` is the Monday block 1 began).
- **Targets** (`settings.openTarget`, `plan.goal.target`). `healthy` stays easy
  (`isBase` throughout), `further` is easy with a long-run ceiling that starts
  at the style's `peakLong(distanceKm)` and grows 10% a block, `faster` puts
  tempo/intervals in weeks 2-3 of every block (phase BUILD, the only open
  target that does). `light` (`settings.lightPlan`) keeps the two longest
  configured days, all easy, the long run a plain EASY (run/walk keeps its
  ratio). Run/walk reads BUILD from its second block so the ratio keeps
  ramping.
- **The checkpoint** is the style's own easy type (`EASY`; `WALK` for run/walk;
  never `RACE`, never `TEMPO`) with `sd: {kind: "checkpoint", km, variant}` and
  a ratio for run/walk. `checkpointDesc` (`_shared/coach/open.mjs`) writes the
  English sentence, `renderSd` the localized one (fr "séance test", es "sesión
  de control"), `sessionSteps` branches on `sd.kind`. It is a marker of the
  `sd`, not a type: retyping replaces `sd` and the marker goes; resizing
  (`planEdit`, the coach's distance tools) rewrites `sd.km` and the sentence.
- **Pace** (`src/utils/openPace.ts`): the runner's own goal time if set, else
  the fastest of their last 8 weeks' efforts projected (Riegel) to the plan's
  distance (`effortsFor`, 3 km and up), else `suggestedGoalSec`. Recorded as
  `goal.paceSource`.
- **Races inside the window** fold in exactly as for a race plan (the overlay
  and its mini-taper, relative to `distanceKm`); only the "before the main
  race" bound is gone. A plan opened behind a race keeps `afterRace` (lead
  `RECOVERY` weeks, `openedAfter`).
- **Extension.** `extendOpenPlan(plan, built)` (pure, `plan.ts`) appends the
  weeks of a build (made with the plan's `blockOffset`, weeks since
  `goal.startDate`) dated from the plan's end, renumbered after the last week
  with slot ids re-minted; earlier weeks are untouched, so a runner's edits
  and ticks survive. It is due once today is inside the last block
  (`extensionDue`); the plan's own end is the idempotence, so a second call, or
  a second device that has synced the extension, finds nothing due
  (`goal.extendedThrough` records how far it went). Written by
  `runPlanAutomation`, below.
- **Validator, edits, coach.** `canHoldTraining` is always true for a plan that
  isn't a race plan; the ramp and back-to-back rules still apply and there is
  nothing to taper to. The coach's GOAL line says "keep improving, faster at 10
  km (4-week blocks ending in a checkpoint run, no race date)", and
  `reassess_goal_feasibility` answers that there is no goal to judge.
- **Automatic writes: one function.** `runPlanAutomation` in `RunningCoach.tsx`
  is the only place the app changes a plan on its own. It runs once per boot,
  from the `[loading]` effect after the load (it calls into the latest closure
  through a ref), never on a foreground: a WebView kept alive for days holds a
  stale cache, and an automatic write from it would clobber another device's
  newer blob. It runs only when `isStoreLoaded() && isStoreReconciled()` (`db.ts`:
  an offline-booted cache is not reconciled until the live row has been read)
  and only when the plan and settings refs are still what the cache holds
  (`isCached`: a newer row adopted without a remount leaves them stale), never
  while a recorder is open, reading the refs so a second call in the same
  tick sees the first one's write. It does two things: extend an open plan, and
  **start one for a runner who never answered** "what's next": phase `choosing`,
  `plan.recovery.until + AUTO_START_DAYS` (3) passed, neither `whatsNextFor` nor
  `plan.goal.autoFor` equal to the race key, and (`AUTO_START_NEEDS_RECOVERY_RUN`)
  a running, non-race run logged between race day and `until`. It builds
  `healthy` at about their recent volume through
  `savePlan(carryProgress(plan, built, "rebuild"))` and stamps `autoFor`; Home
  says it can be changed (`autoStartNoticeFor`, spent through `useSeenOnScreen`).
  A plan written before recovery existed has no `until`, so can never start
  itself.
- **Surfaces.** `planPhase` returns `open` (kind, target, block number, next
  checkpoint) for these plans; Home shows `OpenPlanCard` and never "Race Day";
  PlanView heads the plan "Block 2 · checkpoint Sun 23 Nov" and the one goal
  editor has a Race / Keep improving switch (not a second editor). Onboarding's
  fitness branch builds a `block` plan (`goalKind: "block"`, `openTarget:
  "further"`, `distanceKm` the chosen distance, `raceDate: ""`) and no longer
  asks "Over how long?"; there is no recovery tail after a block. "What's
  next?" (`docs/races.md`) is how a race plan becomes an open one.

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

**A rebuild that replaces an existing plan is never one tap.** A rebuild also
wipes every coach edit to the sessions ahead, which the runner can't see from
the edit screen. So PlanView's CTA is "Preview changes": it holds the built
plan and its settings in `pending` and renders `RebuildPreview`, which diffs
the sessions from today on by **calendar date** (`diffPlans`,
`src/utils/planDiff.ts`; ids are grid slots) and collapses unchanged weeks.
Nothing is written until Apply, and Keep/Back discard it. Apply, and the race
toggle's silent rebuild (`setRaceInPlan`), both toast an Undo that puts the
previous plan back through `restorePlan`, which, unlike `savePlan`, doesn't
count as a `plan_generated`. First-time setup builds straight away, since
there is nothing to lose.

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

## Where the runner stands

`planPhase` (`src/utils/planPhase.ts`) is the one definition of how the runner
stands relative to the plan's main race: `active`, `raceWeek` (the 7 days
before race day, and race day itself), `debrief`, `recovery`, `choosing`. **Derived on every read, never
stored**: the plan is the source of truth, so a rebuild, undo or restore can't
leave a phase behind. The core takes `today` as a `YYYY-MM-DD` string and does
no `Date` or i18n work, so it lives in `_shared/coach/phase.mjs` and
`planPhase.ts` is its typed wrapper; the coach reads the same phase for its
`RACE STATUS:` line (`docs/coach-agent.md`).

- The main race is the session with id `race` (fallback: the RACE session dated
  `plan.raceDate`); carried `past-*` sessions are history and never count, which
  is why a rebuild after the race reads as `active` again. Its edition is the
  session's `editionId`, else `settings.targetEditionId` when the settings name
  the same date (onboarding builds without `mainEditionId`). No edition means a
  hand-entered race and neutral copy.
- Settled = the session is done/skipped, else the main race's participation is
  (races detected before sessions were ticked have only the latter). Skipped goes
  straight to `choosing`. Unsettled: after race day the debrief **asks** for 28
  days, then `choosing`. Done: "How did it feel?" is offered for 2 days while the
  linked run's `effort` is null (four chips: easy 4, hard 6, very hard 8, all out
  10, on the existing 1-10 field), then `recovery` while today is within
  `plan.recovery.until` ("Recovery after the race" above), then `choosing`.
  `PhaseInfo.recovery` (`{until, daysLeft}`, 0 on the last day) is filled in every
  phase that overlaps a window, the debrief included, and is null for a plan with
  no `plan.recovery` and for a race that wasn't run. A plan opened behind a race
  is `active` with `recovery` read from `plan.openedAfter`.
- A plan with no race (`plan.goal.kind` open/block) is phase `open`, with
  `race: null` ("Open plans and blocks" above); the race-only fields are absent
  there, so race readers narrow on them.
- Consumers: the Home race slot (`DebriefCard`, `NextGoalCard`, which opens the
  "What's next?" sheet; race-day mode, `inRaceDayMode`, is checked first and
  untouched), PlanView (finished line and "Set your next goal", which opens the
  same sheet, in place of "Race in 0 days"), StatsView's goal-pace line
  (only before the race). A catalogue date change on the target
  (`dateChanges` with `isTarget`) keeps today's race card instead of the question.
- `overdueSessions` drops every RACE session and, once the main race has passed,
  every session dated on or before it, so the plan never reports the finish line
  or its own run-up as "still open".
- Read the goal from `settings.goalSec`, never `plan.goalSec`: `buildPlan`
  substitutes 7200 for an empty goal.
- The Plan editor opens with an empty race date when the stored one is past, and
  needs a date after today (`min`, an inline message, and `canBuild`);
  onboarding's race step enforces the same.

## Manual edits

The runner can edit their own plan: move a session (or swap it with the one on
the day they pick), change its type or distance, delete it, or add one. It is
free for everyone: the coach is for judgment, not calendar shuffling, and a
change of day should not cost a coach round. `src/utils/planEdit.ts` is the one
set of operations and `SessionEditSheet` the one surface (the Plan tab's
session ⋯ menu, and "Add a session" under each live week); `editSession` in
`RunningCoach.tsx` applies them, with an Undo toast.

- **Warn, never block, on training rules.** `editIssues` runs the shared
  `validatePlan` against the pre-edit plan as baseline and returns what the edit
  newly breaks. The sheet shows it live as a heads-up (Save becomes "Save
  anyway") with a way into the coach. Only *structural* codes (`MALFORMED`,
  `DUPLICATE_ID`, `OUT_OF_WEEK`, `AFTER_RACE`, `SESSION_TOO_LONG`) block, and
  the operations can't produce them: distance is held to 1-40 km, dates to a
  day that is not yet lived, that `canHoldTraining` accepts (before race day, or
  inside the recovery after it) and inside a week. A tempo, intervals or long run
  put inside the recovery is only a heads-up (`RECOVERY_HARD`).
- **The coach's rules, not the coach's refusals.** The coach tools refuse what
  a model shouldn't do unasked (lengthening in the taper, adding past the plan's
  peak); a runner may do those, with the warning. Because the validator waives
  baseline errors, a rule the runner broke on purpose never bricks a later coach
  proposal, and the coach may not make it worse.
- **What stays read-only:** elapsed weeks, done and skipped sessions (undo
  first), and RACE sessions (the goal and the Races tab own them).
- **Shape:** a retyped or added session takes pace/`desc`/`sd` from
  `sessionShapeFor` (`_shared/coach/tools.mjs`), the same derivation the
  coach's `swap_session`/`add_session` use, so `sd` is never stale. On a
  Run/Walk plan the result carries real figures, since a figure-less run/walk
  session has no sentence ratio and no guided schedule: the session's own
  ratio, else one from its week, else the runner's ceiling at that week's phase
  (`runwalkRunSec`). A moved
  session keeps its id; an added one is `user-add-{date}[-n]`. Delete removes the
  session; Skip stays the way to record a missed one.
- **Rebuilds replace edits.** A rebuild is a new plan: moved slot sessions
  carry their `done` by date like any other, but added sessions (not slot ids)
  and deletions don't survive it. The rebuild preview diffs by date, so what a
  rebuild would undo shows there before anything is applied.

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

### Run/Walk ratio (the one style knob a runner sets)

`settings.runWalkRunSec` / `runWalkWalkSec`, read through `runWalkConfig`
(`src/utils/runwalk.ts`) — defaulted to **180 / 60** and clamped, because the
pair rides the user-writable blob. The run figure is a **ceiling, not a starting
point**: `runwalkRunSec(cfg, phase)` ramps thirds of it (BASE ⅓, BUILD/TAPER ⅔,
PEAK the ceiling itself), rounded to 15 s with a 30 s floor, so no week ever
prescribes a longer run interval than the runner said they can hold. At the
default that reproduces the original fixed 1 / 2 / 3 min ladder to the second,
which is why the snapshots didn't move; the taper steps back down with BUILD
(shedding fatigue, not setting a record).

The control lives **inside `StylePicker`**, revealed under the Run/Walk card when
that style is selected — one component, so PlanView's edit screen and both
onboarding branches get it without a second copy. Changing it takes effect on the
next build/rebuild (`genPlan`), like every other plan input. `buildPlan` takes it
as `opts.runWalk` in its *settings* shape (`{runWalkRunSec, runWalkWalkSec}`), so
a call site can pass the settings object straight through.

**Ratios are seconds, and the sd fields are the source of truth.**
`sd.runSec`/`walkSec` carry the ratio; a whole-minute ratio also writes the
pre-seconds `runMin`/`walkMin` so an older client still renders the sentence.
`runwalkRatio(session, desc)` (`src/utils/sessionSteps.ts`) is the ONE reader —
sd seconds, then sd minutes, then a parse of the canonical English desc — and
both the prose (`sessionSteps`) and the guided schedule (`compileWorkout`) go
through it, so they can never quote different figures. Sentence figures are
composed by `fmt.interval` ("3 min", "1 min 30 s", "45 s" — language-neutral
tokens, like rep distances), which is why the locale templates interpolate
`{{run}}`/`{{walk}}` complete with their units.

## Fitness signal & suggested days

`settings.trainingLevel` (`"none"|"occasional"|"regular"|"frequent"`, synced)
is onboarding's one-question self-report ("How much do you run right now?",
`LevelTiles` in both branches, optional). It substitutes for run history ONLY
when none exists: `recommendStyle` maps it to a synthetic weekly-km band (real
logged runs always win) and `buildPlan`'s `opts.level` floors the starting long
run (`levelStartLongKm`, capped at the race peak) and, below 3 logged runs, the easy-day line (`levelEasyKm`).

`suggestPlanSessions(distance, level)` (`planStyles.ts`) provides default
training days — minutes must come from `SessionConfigurator`'s fixed option
set, the Sunday session strictly longest, quality days ≥2 from Sunday so
`pickHardDays` places without demotions. Onboarding uses the same
null-=-tracking pattern as the style (the stock Wed30/Sun60 default counts as
untouched); PlanView offers it as a "Use suggested days" one-tap fill, never
overriding a configured draft.
