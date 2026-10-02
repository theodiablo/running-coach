# Today's run and audio guidance

Live in-run guidance: the GPS recorder knows what today's run is (a regular
run, a tempo, intervals or run/walk), which step of it the runner is in, shows
the target and what's left, verdicts the current pace and heart rate, cues
transitions ("recover, 90 seconds" / "rep 3 of 6") and, with audio guidance on,
speaks a status callout every N seconds — screen on or off. Free for everyone.

## The recorder screen

`LiveRunTracker` reads top to bottom as one question per zone:

1. **Warnings** — a run to recover (which disables Start until answered) and the
   Android battery nudge.
2. **Can I go?** — chips for GPS accuracy and heart rate (live bpm, "added after
   the run" for a post-run store, or "Connect a sensor").
3. **Today's run** — `WorkoutCard`, opening `WorkoutSheet`.
4. **The extras**, one row shape each (`RecorderOptionRow`): Audio guidance
   (`AudioGuideSheet`), Share live (switch on the row, link in
   `LiveShareSheet`), Route (premium route finder).
5. **Start**, pinned under the thumb.

No zero stats before Start. Once running, the rows collapse into two quick
buttons (audio on/off, sharing) under the guided panel and the four stats (heart
rate takes the 4th tile when a live sensor is paired; elevation moves under
pace). Every sheet is a `RecorderSheet` (registers `useDismissable`, sits above
the map and below `ModalOverlay` confirms).

**The workout and the audio are separate on purpose.** The workout says what the
run is and owns every target (pace, HR zone); audio guidance only says how the
coach talks about it (how often, how much leeway, warn on HR, what it reads
out). The panel guides on screen with audio off.

## Today's run — `WorkoutSpec` (`src/utils/workoutSpec.ts`)

The runner-editable description: `type` (`regular` | `tempo` | `intervals` |
`runwalk`), a regular run's optional goal (distance or time), warm-up/cool-down,
block/reps/recovery (each by distance or time), run/walk seconds, `pace` and an
HR zone span. `specFromSession` seeds it from the plan session **through
`compileWorkout`** (so the figures still come from the parser shared with the
prose — a parity test pins `compileSpec(specFromSession(s))` to
`compileWorkout(s)`); unstructured sessions become a regular run with the
session's distance, pace and `SESSION_ZONES` zone. `compileSpec` builds the
step schedule; work/steady/run steps carry `pace` + `band` (the runner's
leeway) and `hrLo`/`hrHi` (zone → bpm by `zoneBpm`, Karvonen on the profile).

- Edits to a plan session's run are **this recording only** — the plan is never
  written. A free run starts from the last free run's spec
  (`settings.freeWorkout`, synced, read through `readSpec`).
- Audio starts **on** for tempo/intervals/run-walk sessions, **off** for
  easy/long/race ones; a free run remembers its last choice (`freeOn`).
- An open regular run (no goal, no pace, no zone) with audio off compiles to
  nothing: no panel, no engine — the plain recorder.

## Audio guidance — callouts (`src/utils/callout.ts`)

`AudioPrefs` (`settings.audioGuide`, synced, read through `readAudioPrefs`):
`freq` (30/60/90/120 s or each km; default 60 s), `band` (± s/km, default 10),
`hrWarn` (`"off"`, above the zone, or 5 bpm above), `say` (pace, heart rate,
distance, what's left), `freeOn`.

- `calloutDue`: time callouts run on **moving** time and wait
  `CALLOUT_MIN_INTO_STEP_SEC` into a step (GPS pace settling); per-km ones fire
  on each whole km and always name the distance. A step announcement resets the
  clock, so a callout never lands on top of one.
- `hrWarnDue`: steps carrying an HR target — work and steady only (run/walk's
  breaks keep it in zone, and race day has no zone), live (non-stale) bpm over
  `hrHi + margin`, at most every `HR_WARN_EVERY_SEC`; spoken at once.
- The schedule is frozen once the run starts, so a synced prefs or HR-profile
  change landing mid-run can't restart it.
- `calloutContent` decides what the sentence holds; the hook words it
  (`tracker.guided.speak.*`). The old 25 s "too fast / too slow" nag is gone —
  the verdict lives inside the callout.
- "Hear it" plays `guide.sample(prefs)` through `previewCue` (Android: the
  plugin's `preview`, since JS cues are silent there).

**The first-tempo tour** (`GuidanceTour`): on the first tempo/intervals session
the recorder opens with, the screen dims except the workout card, then the
audio row. `settings.guidanceTourSeen` is spent the moment it shows; absent
counts as unseen — unlike the seeded-false coach signposts — because it
explains a behaviour change (guidance now talks by default) to exactly the
runners who already had the recorder.

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
  `null`; `specFromSession` turns them into a regular run instead.
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
  released after (music ducks for the prompt only). Speaking from the
  background needs the `audio` background mode (Info.plist): the session is
  released between cues, and iOS won't re-activate playback for a backgrounded
  app without it. It is declared for spoken run guidance, which App Review
  notes should say. JS keeps running under
  background location on iOS, so cues stay JS-driven — except a time boundary
  a stationary runner won't produce a fix for: the hook arms ONE native
  one-shot (`schedule`, re-armed on drift >2.5s, disarmed on pause) so
  "start again" still sounds from a locked pocket.
- **Android**: JS cues are suppressed entirely; the native engine below owns
  every sound, foreground included (the LIVE_FIX fold runs the whole run —
  two speakers would double-cue).

Whether anything is spoken is the run's audio switch (the hook only calls in
when it's on); Android learns it via the seed's `muted`. Status callouts use
the short `info` blip.

## Android — the native engine (`WorkoutGuidePlugin.kt`)

Backgrounded Android runs NO JS, so the whole schedule is evaluated natively.
The plugin is the third consumer of the patched plugin's LIVE_FIX relay
(after the notification fold and LivePublish — one native fold, never a
second copy of the acceptance gates): each broadcast carries the fold's own
cumulative `km`, `durationSec` (moving) and `curPaceSecPerKm`. Time-bound
steps get a Handler deadline (native timers don't freeze), re-armed after
every evaluation — a standing recovery emits no fixes but still ends on time.
Boundaries → ToneGenerator + Android TTS (seeded pre-localized strings,
`USAGE_ASSISTANCE_NAVIGATION_GUIDANCE`; music ducks because each cue holds
`AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK` focus until the utterance is done — the
usage alone ducks nothing; no permission needed) + vibration (VIBRATE
permission, normal-level) + its own silent, `VISIBILITY_PUBLIC` "current
step" notification — deliberately a SECOND notification: the recording one is
owned by the patched service, which rebuilds its message natively and would
drop any step suffix.

**Callouts and HR warnings are native too**, mirroring `src/utils/callout.ts`
(change both together). The live bpm comes from the patched BLE plugin's
`HR_SAMPLE` relay (the GATT callback, so it keeps arriving while JS is frozen),
stale after 12 s like `HR_STALE_MS`. The seed carries the prefs (`callout`)
and the sentences as templates with `{pace}` `{target}` `{bpm}` `{km}` `{n}`
holes the plugin fills; `decimalSep` localizes the km figure. The Handler
deadline also covers the next time-based callout. The callout clock is
native-owned like the announcement dedupe (JS never speaks on Android) and
resets only on teardown or a seed that went backwards.

**JS stays the authority.** `src/geo/workoutGuide.ts` re-seeds the full
engine state (schedule + step index/anchors + km/movingSec + tracking/muted)
on every material change — start, step transition, pause/resume, audio toggle — so
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

## Free

Guided workouts were premium-first; they moved to free with audio guidance
(`docs/monetization.md`). There is no gate and no entitlement re-read.

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
