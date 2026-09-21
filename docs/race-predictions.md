# Race predictions

Progress → Stats shows two independent projections per distance, both in
`src/utils/predictions.ts` and rendered by `RacePredictions` in
`src/views/StatsView.tsx`. The info panel (`src/components/PredictionsInfo.tsx`)
is the user-facing mirror of this file — change one, change the other.

Inputs are the period-filtered runs with cross-training excluded
(`isCrossTraining`): a bike's distance and its HR at a different economy anchor
neither model. Distances are grade-adjusted first (`flatEqKm`, `VERT_COST` per
metre climbed), so a hilly run doesn't read as unfit; only a race card with a
known climb adds its own course back.

## What it projects to

`raceTargets` (`src/utils/raceTargets.ts`) decides the distances, and the runner's
own upcoming races decide them: one card per wishlisted race with a future date,
soonest first, capped at `MAX_RACE_TARGETS`. The fixed 5/10/20 ladder it replaced
answered a question nobody asked — it printed a 5 km for a runner racing 14.5 km
that week and had no row for the race itself, while the 20 km row said "race day"
only because 20 happened to be on the ladder. The ladder survives, flat and
collapsed, as the general picture; with no races it opens as the fallback so a
new account loses nothing.

Three things the helper is carrying, each with a test:

- **The goal race.** `targetEditionId` names it; a race typed into Plan setup has
  no catalogue edition, so date + distance is the fallback handle (the same
  reasoning as `RacesView`'s `inPlannable`). Its card carries the goal line.
- **A plan race that was never added to the Races tab** gets a synthetic card from
  the settings alone. Without it, the one row the old ladder did get right would
  have been lost.
- **The cap never drops the goal race.** The A race a block builds to is usually
  the furthest out, so a plain `slice` is exactly what would drop it.

**`elevationKnown` is not `elevation > 0`.** A trail race with no climb on record
projects as flat and reads absurdly optimistic, so the card says which it is:
known-flat is silent, unknown gets an amber note, and the goal race gets a button
into Plan where the climb can be set. The catalogue supplies the climb
(`findEdition`), and the runner's own `raceElevation` wins over it — that is the
number the plan was built against.

`goalGap` puts the plan's goal time beside both estimates, and stays silent unless
the card is the goal race AND its distance matches the one the goal was set for:
offering a 20 km goal against a 10 km tune-up compares two different things.

## Best-effort estimate

`bestEffortAnchor` picks one run — the strongest, not the fastest: every run
≥ 3 km with a time is normalised to its Riegel-equivalent 10 km, and the lowest
wins, so a quick 1 km blip can't outrank a strong 12 km. Projected out with
`riegel` (k = 1.06).

## HR-modelled estimate

`hrModelAnchor` fits grade-adjusted pace (s/km) against average HR and reads off
the pace held at threshold HR (bottom of Z4, Karvonen), anchored as
{km covered in 3600 s, 3600 s} for Riegel. It exists to credit efficiency —
easy runs handled well, not just the best day.

**The slope is not the least-squares slope, and this is the load-bearing part.**
A real base-building log is all easy runs inside a 15–20 bpm window, where pace
noise (terrain, stops, GPS, whole-run averages) dwarfs the HR signal in it. OLS
there returns a near-flat line whose SE at threshold exceeds `MAX_SE_FRAC`, so
the model hid itself from runners with months of data — 25 runs and nothing
shown. Instead the fitted slope is blended with a physiological prior
(`PRIOR_PACE_PER_RESERVE`: pace changes by ~1.4 mean-paces across the full HR
reserve, so it self-scales to the individual), precision-weighted by the fit's
own `sxx / resSd²` against the prior's `1 / (CV·prior)²`. Clean, wide-spread
data keeps its own slope; scattered narrow data falls back towards the prior
applied to the runner's own centroid. The blend narrows the SE honestly — the
prior's uncertainty is *in* `slopeSd` — which is why the gate then passes rather
than being loosened.

The bounds that keep the extrapolation sane:

- **Z1 points dropped** (`FIT_HR_FLOOR_PCT`). Two recovery-zone walk/jogs 25 bpm
  below everything else once steepened the fit to −8 s/km/bpm and turned a 26:38
  5 km runner into an 18:07 one. `WALK` sessions are dropped by type too, for the
  walk that happens to clear Z2.
- **Slow-side outliers trimmed** (`SLOW_TRIM_MAD`, one-sided on purpose). A run
  can be accidentally slow — walk breaks, red lights, a photo stop — but never
  accidentally fast, and those runs' HR barely drops while their pace collapses.
  Trimming both sides would throw away the fast runs that *are* the signal.
- **Slope capped** at `MAX_SLOPE_OVER_PRIOR` × the prior. Only bites on data too
  clean to shrink (a perfect line keeps its own slope), i.e. a leverage point.
- **Read-off HR held within `MAX_EXTRAP_BPM`** of the hardest effort logged; the
  anchor reports `capped` and the copy says so.
- **Clamped to `MAX_GAIN_OVER_BEST`** × the best effort's hourly distance.

## Gating, and saying which gate

`hrModelUsable` is the one gate: `MIN_FIT_RUNS` points, `MIN_FIT_SPREAD` bpm of
effort spread, a negative slope, and SE at the read-off HR within `MAX_SE_FRAC`
of the predicted pace. Below any of them the HR column doesn't render.

A hidden model must always say *which* gate — `hrModelBlocker` returns
`noData | few | spread | flat | scatter` and `hrModelGap` the shortfall in runs
and bpm, mapped to one copy line each by `HR_LOCKED_COPY`. "Needs more data"
with no idea which kind reads as broken to someone who has been logging for
months, and that confusion is what surfaced this whole rework.

## If you retune this

Tuning constants up or down is the wrong first move — the failure mode is
always the *conditioning* of the fit, not the thresholds. Verify against a real
log, not a synthetic straight line: fixtures with `resSd` 0 skip the shrinkage
entirely and will tell you nothing. `src/utils/predictions.test.ts` carries a
real base-building log as the case that must stay printable and sane.
