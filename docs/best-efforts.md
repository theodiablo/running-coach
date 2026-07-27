# Best efforts & the post-run reward

How the app answers "was that my fastest 5K?" — the extraction, the ranking, and
the one surface that celebrates it. Read this before changing the distance list,
the window algorithm, or the copy that makes a claim about a user's history.

Everything here is **free on every platform**. The ranked *history* behind it
(PB progression over time, trends) is the premium deep-analytics surface — see
`docs/monetization.md`.

## The shape

- `src/utils/bestEfforts.ts` — the whole algorithm. Pure, no React, no network.
- `src/bestEffortsBackfill.ts` — the one-time pass over pre-feature GPS runs.
- `src/components/EffortRow.tsx` — one "fastest 5K · 24:31" line, shared.
- `src/modals/RunAchievementSheet.tsx` — the post-run reward.
- `src/i18n/locales/*/bestEfforts.json` — all copy.

Standard distances are 1K, 5K, 10K, half and marathon (`BEST_EFFORT_DISTANCES`,
ordered shortest-first — `wholeRunEfforts` relies on that order to match the
tightest distance). Adding one means adding a `dist.*` string in all three
locales.

## Cost: there isn't one

This is why the feature could ship free. Efforts are extracted **once, at save
time**, from the GPS trace the app already holds, and stored on the run as
`bestEfforts` (seconds, keyed by distance). Every later question — "is this a
PB?", "where does it rank?" — is then an in-memory scan of `runs`. No model
call, no edge function, no refetch of a trace, and it works offline.

The one thing that would blow this up is recomputing efforts by re-downloading
route rows. Don't. If a surface needs efforts, read `effortsFor(run)`.

## Extraction

`bestEffortsFromTrack(points)` walks the shared `flattenTrack` (the same
gap-aware, jitter-gated distance walk `buildSplits` and `buildRunSeries` use, so
splits and efforts can't disagree) and runs a two-pointer sweep per distance.

Three rules that matter:

- **Windows never span a gap marker.** `cumKm` deliberately doesn't accrue across
  a gap while wall-clock time does, so a window crossing one would price real
  distance against dead time. Segments are measured independently.
- **Nor an impossibly fast leg.** That is the same problem wearing a disguise, and
  the dangerous one: **no import path emits gap markers** (`fit.ts`, `gpx.ts`,
  `imports/series.ts` all build unbroken arrays), so a stretch travelled with the
  watch paused arrives as one ordinary leg. Interpolating across a 20 km drive
  yields a 30-second kilometre, which is then stored and poisons every later
  ranking. `trackSegments` cuts the track at anything above `MAX_LEG_SPEED_MS`
  (10 m/s — 1:40/km, past the 1000 m world record), which also disposes of a
  teleporting GPS fix. `dt` is floored at 1 s: import timestamps are routinely
  whole-second, and a raw distance/dt would call every same-second leg infinite.
- **The window's start is interpolated, its end is pinned to a real fix.** So the
  covered distance is exactly the target rather than quantised to whole fixes.
  Pinning the end errs **slow**. The interpolated start assumes an even pace
  across its leg, so it can land a second or two either side of the truth — and
  note that stored traces are **simplified** (5 m Douglas-Peucker), so a straight
  stretch collapses into one long leg and "at most one sample" does not hold. The
  bound is sub-leg pace variation, not zero; don't write copy that promises more.

A sub-`GAP_MS` pause leaves no gap marker, so it lands inside a segment as time
without distance — which makes the window slower, never faster. Also safe.

## Runs with no trace

A manual entry, or a watch import with no GPS, has no distance axis. It still
counts as an effort at the **one** standard distance it essentially *is*:
`wholeRunEfforts` credits a run whose distance falls in `[d × 0.99, d × 1.05]`,
scaling its own time to the exact distance. A logged 10.4 km is a 10K; a 12 km
easy run is not.

The window is wider on the long side because that's where the real spread is, but
it is **not one-sided**: a half is routinely logged as a round `21` and a marathon
as `42` (some catalogue editions store them that way too), and those got no effort
at all while `21.1` worked. Scaling a slightly-short run *up* lengthens its time,
so the short tolerance can't manufacture a fast one.

Deliberately not extended to longer runs. Average pace over a 12 km easy run is
not a 10K effort, and inventing one would let a slow long run masquerade as a
race performance — which then poisons every future PB comparison.

`effortsFor(run)` is the single reader, and it merges **per distance, not per
run**: measured values win, and the estimate fills only the distances the trace
didn't yield. That gap-filling is not a nicety. A GPS 5K measures a few tens of
metres short once jitter gating and 5 m simplification have had their way, so it
stores `{1k}` — and an all-or-nothing fallback then left it with no 5K at all,
permanently, because a non-empty stored map also keeps the backfill away, while
the very same run typed in by hand ranked fine. `measuredEfforts(run)` is the
provenance source: `rankRunEfforts` stamps each rank with `estimated`, so the
detail card footnotes exactly the rows it's estimating, mixed runs included.

**Walks and `OTHER` entries get nothing** (`countsAsRunning`). A distance is a
claim about running: "first 5K on the board" for a family walk is false, and
counting one inflates `total`, which loosens the `rank < total` guard below. The
filter is applied at read time, so re-typing a run fixes it retroactively either
way — which is why every path still *measures* unconditionally.

## Ranking

`rankRunEfforts(run, allRuns)` returns, per distance the run covers: the time,
the rank (1 = fastest), how many runs are comparable, the standing best among the
*others*, and the gain over it. The run is excluded from its own comparison by
`id`.

- **A tie ranks equal-best.** Only strictly faster runs push you down, so
  repeating your exact PB reads as a personal best with `gainSec: 0`, not a
  demotion.
- **`total === 1` is a first effort, not a personal best.** `isFirstEffort` and
  `isPersonalBest` exist so copy never says "fastest ever" when there is nothing
  to have been faster than.

`runAchievements` filters to `ACHIEVEMENT_MAX_RANK` (3) and sorts best-rank-first.
The rank badges are spelled out as literal keys in `EffortRow` rather than built
from the number, so the dangling-key test checks them and raising the ceiling
fails loudly instead of rendering a raw key.

**A runner-up rank must have actually beaten something** (`rank < total`). "3rd
fastest" out of exactly three runs is last place wearing a rosette, and without
that guard a new user would collect one after every early run. Rank 1 is always
kept — a first effort is worth marking even with nothing to compare against.

This self-regulates nicely: a new runner tops a short list often (which is the
point), and a veteran's top-3 out of 200 runs is genuinely worth a burst.

## Where efforts get written

Every path that produces a GPS trace measures it, off the **simplified** points
that actually get stored, so the detail view and any later pass agree:

| Path | Where |
|---|---|
| Live tracker | `LiveRunTracker.handleSave` → `onFinish` prefill |
| Prefill → save | `LogView.submit` carries `prefill.bestEfforts` through |
| File / watch / cloud import | `persistImportedRoute` |
| Pre-feature GPS runs | `bestEffortsBackfill`, once per user per device |

`bestEfforts` is stamped **even when empty** — `{}` means "measured, covers no
standard distance" and is what keeps the backfill off that run. Absent means
never measured.

The tracker's efforts survive the user correcting distance or duration in the
log form on the way in: they came from the trace, which that form can't edit.

## The backfill

Without it, the reward would greet a long-time user's next run with "first 5K on
record", or call it their fastest when an older, faster 5K sits unmeasured inside
a 10 km trace. `backfillBestEfforts` measures pre-feature GPS runs once per
user per device, and is deliberately timid:

- newest `RUN_LIMIT` (40) runs only, so a long history can't turn a cold start
  into a multi-megabyte download;
- points only (`getRoute(id, false)`) — the stats sidecar can hold a whole ~1Hz
  HR stream it doesn't need;
- sequential, silent, off the critical path;
- the done-marker lives in `localStorage` and is written **only** when a pass
  completes with no fetch failures, so an offline cold start retries later. It is
  **keyed by user id**: `localStorage` survives sign-out, so a device-global key
  told the second account on a shared phone that its own pre-feature runs had
  already been measured — the exact false "first 5K on record" the backfill
  exists to prevent. No user id means "done", and nothing is written: a marker
  stamped before the session is known would be unreachable once it is.

It returns patches rather than writing state, keeping the single blob write with
the owner of `runs`. In `RunningCoach` it is chained **after** the boot HR flush
on purpose: that path writes a captured `bootRuns` array wholesale, so an
overlapping backfill patch would be silently overwritten.

**Known limit:** a genuine PB buried in a trace older than the 40-run cap is
missed, and those runs keep their whole-run estimate. Accepted — the alternative
is an unbounded download at boot. If the premium PB-history surface needs full
coverage, that's the place to do a deeper, user-initiated pass.

## Surfaces

- **`RunAchievementSheet`** — fires from `addRuns` when a **single** saved run
  lands in the top three. A batch (CSV import, multi-run watch sync) never pops
  it. Confetti only for a real personal best, and suppressed when race-day
  detection is already firing its own burst, so a save never produces two.
- **Run detail card** — the same rows, durable. Not gated on a trace: a manually
  logged 5K still ranks. Footnotes the estimate when the run was never measured.

Both mount only when there is something to say. There is no consolation state.

## If you extend this

- Nothing here may claim more than the log supports. "Fastest ever" is a claim
  about the user's *record*, and the first-effort / measured-vs-estimated splits
  exist to keep it true.
- Keep the algorithm in `src/utils/bestEfforts.ts`. It's pure and unit-tested;
  UI surfaces should only read `effortsFor` / `rankRunEfforts` / `runAchievements`.
- Not wired yet, and reasonable next steps: a telemetry event on a PB (read
  `docs/telemetry.md` first), the coach knowing a run was a PB, and the premium
  PB-progression surface in Progress → Stats.
