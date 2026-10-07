# Stretching

Guided, running-specific stretching: four routines with a drawn figure, a hold
timer, side switches and voice cues, suggested on Home at the two moments that
make sense (right after a run, the day after a big one). **Premium only, as a
test flag** (see "Gating"). The proposal and the decisions behind it were
reviewed with the maintainer in October 2026.

## What the research supports (and what the copy must never claim)

- **Before a hard run:** dynamic drills, not long holds. Measured right after
  stretching, static stretching cost a little performance on average and
  dynamic gained a little (Behm et al. 2016, pooled: -3.7% / +1.3%), with the
  cost concentrated in holds over ~60 s per muscle. The warm-up is all movement.
- **After a run:** static holds, ~30 s a side. The easiest moment to make it a
  habit. It does **not** meaningfully reduce next-day soreness (Cochrane,
  Herbert et al. 2011; Afonso et al. 2021 found no effect, at very low certainty).
- **How often:** at least 2-3 days a week, ~60 s per muscle in total, daily is
  best (ACSM position stand, Garber et al. 2011).
- **Injuries:** stretching does **not** prevent them (Lauersen et al. 2014, RR
  0.96); strength training does (RR 0.32). That is why a strength routine is the
  natural next phase. Gradual load progression is common advice but has no
  trial support for runners (Buist 2008), so the FAQ doesn't claim it.
- The 45 s holds after hills or a hard session are the app's own call, not a
  research figure, and the FAQ says so.

So the copy says what holds (range of motion over weeks, a calm finish, it feels
good) and never "prevents injuries" or "recover faster". The same honesty rule
as best efforts and predictions. The user-facing version of this section is the
"About stretching" FAQ (`stretch.info.*`): the research, then "How the app
decides". Keep the two in step when a rule below changes.

## Shape

- `src/stretch/poses.ts`: each move as joint coordinates on a 200×200 side-view
  board; `far` limbs behind the body, `near` in front, `target` the stretched
  muscle (drawn teal). Drills have two key frames with identical shapes,
  interpolated by `poseAt`. No image files: ~1 KB a pose, nothing to translate,
  works offline. `src/components/StretchFigure.tsx` is the one renderer.
- `src/stretch/routines.ts`: the moves and the four routines (cool-down,
  recovery, warm-up, rest-day). `cooldownFor(focus)` reshapes the cool-down for
  the run it follows: hilly (15+ m climb per km) puts calves first at 45 s; a
  tempo, interval or race session gives hips and hamstrings 45 s.
- `src/utils/stretchEngine.ts`: pure. A routine flattens into steps (5 s prep +
  the hold, two-sided moves split left then right); `positionAt(steps, elapsed)`
  reads the position from elapsed time, never from counted ticks, so a screen
  that slept catches up.
- `src/utils/stretchSuggest.ts`: pure, **derived on every render, never stored**
  (the overdue-sessions rule). At most one suggestion a day:
  1. a run today (15+ min, some distance, not cross-training; one that ran past
     midnight counts for the day it ended) with no stretch logged after it ends
     (a hand-logged run has no `startedAt`, so any stretch today counts): the
     cool-down;
  2. else, a long run, a race or a 90+ min run yesterday, no hard session
     planned today and nothing logged today: recovery mobility.
  Off when `settings.stretchSuggest === false`, when `stretchDismissed` is today
  ("Not today", whose toast links to Training profile), and while a recorder is
  open: the player's audio and screen lock would fight the recorder's, so
  `openStretch` refuses too.
- `src/modals/StretchSheet.tsx` (routine list + one routine's preview) and
  `src/modals/StretchPlayer.tsx`: one lazy chunk, loaded from `RunningCoach`
  behind `ChunkLoadBoundary`. A Home suggestion opens straight on its routine
  and says why; back from a routine picked in the list returns to the list.

## The player

- The clock is `{startedAt}` while running and `{elapsed}` while paused; the
  250 ms interval only re-renders. Completion and cues happen in that tick or in
  a handler, never in an effect, and completion is guarded to fire once. The
  "Stop this routine?" question pauses the clock, so it can't finish behind it.
- **What gets logged is the time actually played**, not the routine's length,
  and under 60 s (a tap-through on Skip) is not a session at all: nothing is
  logged and the done screen says so. Future readers of `sec` (the coach, a
  Health Connect / HealthKit export) can trust it.
- **The screen stays on while the routine runs** (`useKeepAwake`: the
  `@capacitor-community/keep-awake` plugin on native, `navigator.wakeLock` on
  web), never while paused or idle. The player is read while in use, the
  opposite of a recording: never reuse this for a recorder, which runs
  screen-off in a pocket.
- **Sound:** a beep at each change, and voice (on by default, `stretchVoice`)
  naming the next stretch and "switch sides". `stretchCue` in `src/cues`: iOS
  through `AudioCue`; web and Android beep through Web Audio, and Android speaks
  through the guide plugin's TTS (`playCue` is silent on Android on purpose,
  because the native workout guide owns sound during a run). `primeStretchCues`
  runs from the Start tap. Web speech is cancelled before each announcement so
  fast skips don't queue stale ones (Android's TTS flushes on its own; iOS may
  lag one), and the final "done" cue is not cut off by the player closing.
- Leaving a routine under way asks first (`ModalOverlay`, never `confirm`).

## Data

- `STORAGE_KEYS.STRETCH_LOG` (`rc_stretch_log`): `[{date, at, routine, sec}]`,
  written when a routine completes, capped at 200. It feeds "already stretched
  today" and the weekly count. **A stretch is not a run**: it never enters
  `runs`, so it can't touch volume, PBs or predictions. Included in backup and
  restore.
- The week shows as a count of sessions since Monday against the usual 2-3,
  **never a streak** (the `badges.ts` stance).
- Settings → Training profile holds the two synced switches (suggestions,
  voice), so a dismissed banner always has a visible way back on.

## Gating

- Everything is behind `isPremium`, which makes it a test flag while grants are
  manual. The Record sheet row follows the house rule (`isPremium ||
  canShowPremiumTeaser`, a free tap gets `PremiumTeaserSheet`). The Home
  suggestion and the Help section stay `isPremium` only: a suggestion is the
  feature itself, and a locked one after every run would be an ad.
- The FAQ opens with a "Testing" notice (`stretch.info.testing`): only test
  accounts see the feature and it isn't public yet. Remove it when it opens.
- **The gate is client-side only.** The content ships in the (lazy) bundle and
  there is no server half, the same reason guided workouts went free. Whether it
  stays premium (and moves its content behind an edge function) or opens to
  everyone is decided after the test; see the lineup in `docs/monetization.md`.

## Next

Phase 2: warm-up drills offered on tempo/interval/race session cards and in the
recorder before Start; a rest-day suggestion when fewer than 2 sessions in 7
days. Phase 3: a runner strength routine, the coach reading the stretch log,
Health Connect / HealthKit flexibility sessions.
