# Guided workouts (premium)

Live in-run guidance for structured sessions — tempo, intervals, and Galloway
run/walk: the tracker knows which step of the session the runner is in, shows
the target and what's left, verdicts the current pace against the band, and
cues transitions ("recover, 90 seconds" / "rep 3 of 6") by beep + voice, with
the screen on or off. Opened by recording FROM a plan session card ("Record
run"), never on a bare tracker open.

## Compilation — one source of truth with the prose

`compileWorkout(session)` (`src/utils/workout.ts`) turns a plan session into a
step schedule `{steps, loopFrom?}`; each step is distance- (`m`) or
time-bound (`sec`), work steps carry `pace` ± `band`. Sources mirror
`sessionSteps` exactly — `sd` first, canonical-English `desc` parse as the
fallback — and the two share the raw parsers (`parseRepsRaw`, `parseRatio` in
`sessionSteps.ts`), so the "how it unfolds" prose and the guided schedule can
never quote different figures. Guided warm-up/cool-down lengths sit inside the
ranges the prose promises (tests pin this). Rules to keep:

- **Interval rows' `km` is the whole outing** (reps + 1.5 km allowance);
  **tempo rows' `km` IS the work block** — see `buildPlan`. The compiler never
  reads interval `km`; it derives everything from reps × repM.
- Warm-up/recovery/cool-down steps carry **no pace target** — the session row
  doesn't know the runner's easy pace and "easy" is the honest instruction.
  Verdicts (`paceVerdict`, band per kind) apply to work steps only.
- Unstructured sessions (easy/long-without-ratio/race/cross) compile to
  `null` — no guidance, the tracker behaves exactly as before.
- Run/walk sessions compile to a looping schedule (`loopFrom`): the engine
  cycles run/walk until the runner stops; a loop never "finishes".

## The engine — pure, and never on a timer

`advanceWorkout(workout, progress, {km, movingSec})` is a pure reducer over
the tracker's cumulative distance and MOVING time (pauses excluded for free).
It advances through every boundary crossed since the last call (screen-on
catch-up can cross several; announce only the last), anchoring each boundary
at its true km/sec — except a time step entered off a distance boundary,
which anchors at "now" (a single snapshot can't say when the rep really
ended; conservative beats early). It is driven by the renders the accepted
GPS fixes and the tracker's foreground 1s tick already produce — **never a
timer of its own** (frozen in background, the repo rule).

`useGuidedWorkout` (`src/hooks/`) orchestrates: progress is derived DURING
render (the PlanView reset pattern — no sync setState in effects); a separate
effect does side effects only (cues, telemetry, native calls). It fans out to
the panel (`GuidedWorkoutPanel`), the cue seam, and the two native paths
below. Step figures and cue phrases are pre-rendered per locale in JS — no
i18n on the native sides.

## Cues — one seam, three backends (`src/cues/`)

- **web**: Web Audio synthesized beeps (no assets, CSP-safe; the AudioContext
  is primed from the Start tap for autoplay policy), `speechSynthesis`,
  `navigator.vibrate`. Web recording is foreground-only anyway.
- **iOS**: the `AudioCue` plugin (`ios/App/App/AudioCuePlugin.swift`) — tones
  synthesized with the SAME patterns as web, `AVSpeechSynthesizer`, on an
  `.playback`/`.voicePrompt` session with `duckOthers` activated per cue and
  released after (music ducks for the prompt only). JS keeps running under
  background location on iOS, so cues stay JS-driven — except a time boundary
  a stationary runner won't produce a fix for: the hook arms ONE native
  one-shot (`schedule`, re-armed on drift >2.5s, disarmed on pause) so
  "start again" still sounds from a locked pocket.
- **Android**: JS cues are suppressed entirely; the native engine below owns
  every sound, foreground included (the LIVE_FIX fold runs the whole run —
  two speakers would double-cue).

Mute is per-device (`WORKOUT_CUES_MUTED_KEY`, toggle on the panel), read at
call time; Android learns it via the seed.

## Android — the native engine (`WorkoutGuidePlugin.kt`)

Backgrounded Android runs NO JS, so the whole schedule is evaluated natively.
The plugin is the third consumer of the patched plugin's LIVE_FIX relay
(after the notification fold and LivePublish — one native fold, never a
second copy of the acceptance gates): each broadcast carries the fold's own
cumulative `km`, `durationSec` (moving) and `curPaceSecPerKm`. Time-bound
steps get a Handler deadline (native timers don't freeze), re-armed after
every evaluation — a standing recovery emits no fixes but still ends on time.
Boundaries → ToneGenerator + Android TTS (seeded pre-localized strings,
`USAGE_ASSISTANCE_NAVIGATION_GUIDANCE` so music ducks) + vibration (VIBRATE
permission, normal-level) + its own silent, `VISIBILITY_PUBLIC` "current
step" notification — deliberately a SECOND notification: the recording one is
owned by the patched service, which rebuilds its message natively and would
drop any step suffix.

**JS stays the authority.** `src/geo/workoutGuide.ts` re-seeds the full
engine state (schedule + step index/anchors + km/movingSec + tracking/muted)
on every material change — start, step transition, pause/resume, mute — so
native drift is bounded by one boundary and snaps back on the next foreground
render. `seed`/`clear` mirror the JS engine's rules; **if `advanceWorkout`
changes, change `evaluate()` with it.** Config is memory-only + self-expiring
(6h), like LivePublish. Numbers are read `Number`-tolerantly (`optNumber`
rule — epoch/whole values arrive as Long).

## iOS — Live Activity step line

`RunActivityAttributes.ContentState` gains optional `step` (nil-safe for old
payloads; the file is compiled into BOTH targets — never fork it), rendered
in orange on the lock-screen card and the Dynamic Island expanded view. The
line rides the existing notification pipeline: `buildRunNotificationContent`
takes `stepText` (compared by `sameNotificationContent`, so a step change
pushes even when km/pace text didn't), `liveNotification` forwards it iOS-only.
The tracker feeds it via `useRunTracker`'s `stepText` option, reconciled
during render in `LiveRunTracker` (derived-state pattern) because the guide
hook needs the tracker's own stats.

## Premium gating

Guided workouts are premium-first (`docs/monetization.md`). The affordance
gate is `isPremium || canShowPremiumTeaser` like every other premium surface;
while the teaser flag is false a free user sees nothing at all. Guidance is
fully client-side — there is no edge function to enforce it, an accepted
exception to the "gate is server-side" rule (a tampered client gains a local
UI, not access to server resources or anyone else's data). Because guidance
auto-appears (no tap to re-check entitlement on), `LiveRunTracker` re-reads
`premium_until` once when a guidable session arrives looking free — an
offline-stale premium user gets their guidance a moment later instead of
never.

## Known limits

- Engine progress is not persisted: an app kill mid-workout recovers the RUN
  (buffer + fix journal) and the engine catches up through the recovered
  distance/time on resume — rep boundaries recompute, announcements don't
  replay.
- The pace verdict reads the tracker's 30s `curPace` window; on short reps the
  verdict lags ~15s into the rep (why `PACE_CUE_MIN_INTO_STEP_SEC` exists).
- Distance boundaries on Android/iOS background resolve on the next accepted
  fix (≥2s apart) — a rep can overshoot by a few metres. Time boundaries are
  exact (Handler / scheduled one-shot).
