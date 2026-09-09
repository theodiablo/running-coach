# Voice input & beta feedback

Two features sharing one seam: dictation into a text field. The coach composer
uses it to speak a message; the beta feedback sheet uses it to speak a report.

## What the devices can do

Everything here is on-device and free. There is no transcription service, no
API key and no per-minute cost.

| Platform | Speech → text | Text → speech |
|---|---|---|
| Android shell | `android.speech.SpeechRecognizer` — OS-provided, free. API 33+ can force a fully offline model. | already shipped: `WorkoutGuidePlugin.kt` drives Android TTS for workout cues |
| iOS shell | `SFSpeechRecognizer` + `AVAudioEngine`, `requiresOnDeviceRecognition = true` (iOS 13+, under the 15.4 floor) | already shipped: `AVSpeechSynthesizer` in `AudioCuePlugin.swift` |

## Why there is no web backend

Deliberate, not a gap to fill later.

- Chrome's `webkitSpeechRecognition` **is not local**: it streams microphone
  audio to Google's servers and returns text. Shipping it would mean a second,
  weaker privacy sentence for one platform while the native shells can honestly
  say "your phone turns this into text".
- Firefox has no implementation at all, so the web would need a disappearing
  mic button on top of that.

`getSpeechSource()` (`src/speech/source.ts`) therefore returns `null` whenever
`isNative` is false. **That null is the entire fallback mechanism** — the mic
renders only when a source exists, so no caller carries a conditional and the
web build is unchanged. `src/speech/source.test.ts` pins it.

## The seam

`getSpeechSource()` → `SpeechSource | null`, mirroring `geoSource` and
`getHrSource`. `prepare()` folds availability and permission into one call;
`start(lang, handlers)` streams `onPartial` / `onFinal` / `onError`.

`useDictation` (`src/hooks/useDictation.ts`) is what UI consumes. It appends
settled text to the field and exposes `supported`, `listening` and `partial`.

Two rules the UI must keep:

- **Interim results are rendered live.** All the recognizers emit partial
  hypotheses; without showing them, four seconds of silence reads as a bug.
- **Never auto-send.** Recognizers mangle names and paces, so the transcript
  always lands in an editable field. On the coach that also means a mis-hear
  costs a tap, not one of the five daily messages.

Permission is requested on first tap, never on a screen's load:
`RECORD_AUDIO` (Android), `NSMicrophoneUsageDescription` +
`NSSpeechRecognitionUsageDescription` (iOS).

## Read-aloud: not built

The coach does not speak its answers yet. The two TTS engines exist but are
not reusable as they stand: Android's `TextToSpeech` lives inside
`WorkoutGuidePlugin`, driven by the workout schedule and holding the
foreground service, and iOS's `AVSpeechSynthesizer` sits behind
`AudioCuePlugin.play`, which wants a cue tone. The `src/cues/` seam is also
deliberately silent on Android, because the native engine owns every sound
there and a JS cue would double up.

Doing it properly means a `speak` method on the *Speech* plugin on both
platforms, with its own audio-session lifecycle coordinated against
`AudioCuePlugin` — and its own per-device mute, not `WORKOUT_CUES_MUTED_KEY`:
silencing interval cues mid-run and silencing the coach are different
intentions.

## Beta feedback

One sheet (`src/modals/FeedbackSheet.tsx`), three doors, all calling
`openFeedback(source)` on the state hub:

1. The floating pill — a sibling of `BottomNav` in `RunningCoach`, never inside
   it (`BottomNav` is presentational and the marketing mockup renders it too).
   `z-30`, above the nav, below the `z-50` sheets. Visible on the four tabs;
   hidden **only** during the live-run recorder, the indoor recorder and
   onboarding, where a beta badge is noise at the worst moment.
2. The coach chat header. Not a pill: the composer's send button already owns
   bottom-right.
3. A row in the Settings hub, below the three sub-page entries and separated by
   a rule so it reads as an action, not a fourth destination. This is the one
   door discoverable by someone who never noticed the pill.

The sheet is `z-[60]` so it clears the coach chat's own `z-50`.

**`beta_feedback` is not `coach_feedback`.** The per-round flag under a coach
bubble (`src/coachFeedback.ts`) reports one wrong ANSWER, is keyed to its
trajectory + round, and is eval signal. Beta feedback reports the product.
Different targets and different lifetimes — keep both.

Storage follows the `coach_feedback` shape exactly: INSERT-only from the
client, no client SELECT, maintainer emailed by `notify-contribution` (a new
`kind`, not a new function) and reads rows in the SQL editor.

**No audio is ever stored.** Speech is transcribed on the device and only the
transcript is submitted — there is no bucket, no upload, and no column should
be added for one.

The one-time pointer at the pill is the existing `Coachmark`, generalised to
two anchors, seeded `feedbackIntroSeen: false` at onboarding completion like
`coachIntroSeen`. It waits for the coach pointer to be spent so the two never
stack on a fresh account's first Home.
