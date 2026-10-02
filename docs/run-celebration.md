# The finish celebration

What the runner sees the moment they hold Finish, before the run summary. It
builds on the best-effort reward (`docs/best-efforts.md`): the same ranked rows,
moved to the moment the run actually ends, wrapped in a headline and one line
about this run.

## The shape

- `src/utils/runCelebration.ts`: pure. `buildCelebration` picks the headline,
  the fact and the effort rows; `celebrationFacts` lists every fact that holds.
- `src/utils/celebrationHistory.ts`: `celebrate()`, the same call with this
  device's recently shown keys kept out of the draw (`CELEBRATION_RECENT_KEY`,
  localStorage, a convenience only).
- `src/modals/RunCelebration.tsx`: the screen. Both recorders mount it from
  their Finish handler (never an effect), so a recovered, already-stopped run
  is not celebrated a second time.
- `src/i18n/locales/*/celebration.json`: all copy. The pools are read off the
  English file's keys, so adding a line means adding a key in all three locales
  (the parity test enforces it). Each locale is written natively, not translated
  line for line, and stays gender-neutral (no `fier`/`orgulloso`).

## What it says

**The headline** comes from a pool: `run` (about 30, mostly warm with a few
playful), `early`/`night` by start time (half the time, for variety), `short`
for a run under 1 km or 5 minutes, `indoor` for a cross-training session, and
`pb` whenever the run is a personal best. About 1 in 100 draws (`RARE_CHANCE`)
comes from the `rare` pool instead, shown with a "1 in 100" chip and confetti;
a personal best outranks it, since that headline says what happened.

**The fact** is at most one line, and every claim is about the runner's OWN log,
never an absolute yardstick (a slow run for one runner is another's record). Same
honesty rules as best efforts: no claim the log can't support, so the
comparisons need history (`MIN_HISTORY` runs, 5 similar runs for pace, 4 weeks
for the biggest week). Weight 3 (milestones, which earn confetti): first run,
run count milestones, lifetime km milestones, longest run, race day. Weight 2:
comeback after 14+ days, longest by time, climbing high, biggest week, first or
longest indoor session. Weight 1: longest in 8 weeks, quicker than usual for
the distance, negative split, the plan session ticked off. The highest weight
present wins; within it, a family not shown recently is preferred.

The negative split makes no claim when any whole-km split is 1.5x the median:
a pause leaves time without distance, so a stop in the first half would
otherwise read as a fast finish.

Copy follows the `badges.ts` stance: a break is "welcome back", never a broken
streak. An accidental recording (under 200 m and 2 min; indoor under 1 min) gets
no celebration at all.

## Timing

The thumb that just held Finish lifts onto this screen, so taps are ignored for
the first ~0.45 s. Without effort rows it moves on to the summary by itself
after 4 s or on a tap; with effort rows it waits for Continue, since there is
something to read.

## One reward per run

A recorded run whose celebration was shown saves with `celebrated: true` on the
prefill (dropped by `carryPrefill`, never stored on the run); `LogView` passes
it to `addRuns`, which then skips `RunAchievementSheet`. That sheet still fires
for a manual entry or a single import, which never passed through a finish
screen.
