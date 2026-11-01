# Run analysis: the moving clock and the running-only breakdown

A run/walk session's average pace describes neither half of it. `RunDetailModal`
answers "how fast was the *running*?" with a **Running only** card: pace,
distance, time, avg HR and bout count for the running and the walking halves,
side by side, above the whole-run tiles.

## Why it is derived, never stored

Nothing on a saved run says which seconds were walked — not even a guided
run/walk session, whose step engine knows the schedule but doesn't journal the
boundaries. The trace is the only record, so `runWalkBreakdown`
(`src/utils/runSegments.ts`) reads the split back out of it at display time,
inside `RunDetailModal`'s one `useMemo` over the fetched trace (alongside
`buildSplits`/`buildRunSeries`). Nothing new is written to the run, so the card
works retroactively on every GPS run already in the log, including unstructured
runs with walk breaks the plan never prescribed.

## The split is drawn against the run's own distribution

There is no absolute "walking is slower than X": a beginner runs at 9:00/km and a
fit runner walks at 8:00/km. So the legs between stored points (time-weighted —
a 30 s leg says more than a 2 s one) go through a weighted 2-means over pace, and
the cut is the midpoint between the two centres. Legs longer than 45 s are
dropped as pauses, and a gap marker is never bridged — a leg spanning one reads as
an hour per km and would swamp the walk cluster.

Bouts shorter than 12 s are merged into their neighbour: at a boundary the
sampling says nothing reliable, and one slow leg mid-run is not a walk break.

## It returns null more often than not, on purpose

The card is an **estimate** and says so. It is also silent unless the run really
reads as two modes — all of: ≥4 min moving, the two centres ≥60 s/km AND ≥25%
apart, each mode owning ≥8% of the moving time, ≥2 bouts of each, and the faster
mode at ≤11:00/km (slower than that, the "running" is walking too). A steady run
has one mode and gets no card, which is the honest answer. Same rule as best
efforts: no surface may claim more than the log supports.

The one thing the estimate needs is temporal resolution. Stored traces are
Douglas-Peucker-thinned at 5 m (`simplify`), and `flattenTrack` ignores legs under
its 3 m jitter floor, so very tightly sampled fixes contribute no distance at all
— the synthetic traces in `runSegments.test.ts` are spaced 5 s apart for that
reason. Cadence is *not* part of this card: cadence is never stored on a run (it
only exists on the live-share payload from an external sensor), so there is
nothing to break down.

## Paused time is not run time

Splits, the pace chart, the run/walk card and the coach's `get_run_detail`
digest all read the trace on the **moving clock**, the same clock the run's
duration is. Wall-clock timestamps would put every pause into the km it fell
in: an interval runner who pauses for recoveries got 7:40 splits on a 4:35/km
run, with splits adding up to 11 minutes more than the run's own time.

- **Pauses are recorded, not detected.** `useRunTracker` stamps each
  Pause→Resume as `[pausedAt, resumedAt]` (a crash recovery adds one from where
  the clock stopped until Resume), the recovery buffer persists them, and the
  save writes them to the route sidecar as `stats.pauses`. GPS stops with the
  clock running are not pauses and are never inferred as such: a walking
  recovery is part of the session.
- **One transform, applied where the trace is loaded**: `tracePausesRemoved` /
  `samplesPausesRemoved` (`src/utils/pauses.ts`, ported in `runDigest.mjs`)
  shift every fix and HR sample back by the time paused before it, and cut the
  track (a gap marker) where a pause fell between two fixes, so no pace is
  measured across one. Analysis code stays clock-agnostic; new trace analysis
  goes through the transform rather than handling pauses itself.
- **Distance is untouched.** Fixes are dropped while paused, so ground covered
  then is the straight-line gap bridge, which still counts (the one distance
  definition) but now costs no time. Walking far while paused therefore makes
  that km read fast; a stop barely moves.
- **Best efforts stay on wall time**, extracted at save from the raw trace: a
  pause can only make an effort slower, never invent one.
- Runs saved before `stats.pauses` existed have no located pauses and read as
  before.
