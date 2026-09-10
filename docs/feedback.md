# Beta feedback

One button, reachable from anywhere, for "this is broken / confusing /
annoying".

## Three doors, one sheet

All three call `openFeedback(source)` on the state hub (`RunningCoach.tsx`),
which opens `src/modals/FeedbackSheet.tsx`:

1. **The floating pill** — a sibling of `BottomNav` in `RunningCoach`, never
   inside it (`BottomNav` is presentational and the marketing mockup renders it
   too). `z-30`, above the nav, below the `z-50` sheets. Visible on the tabs;
   hidden **only** during the live-run recorder, the indoor recorder and
   onboarding, where a beta badge is noise at the worst moment.
2. **The coach chat header.** Not a pill: the composer's send button already
   owns bottom-right.
3. **A row in the Settings hub**, below the three sub-page entries and separated
   by a rule so it reads as an action, not a fourth destination. This is the one
   door discoverable by someone who never noticed the pill.

The sheet is `z-[60]` so it clears the coach chat's own `z-50`, and `tab` is
mapped through `feedbackSourceForTab` rather than cast — an unmapped tab would
otherwise reach the UI as the raw i18n key and land in the stored row.

## Not the same thing as `coach_feedback`

The per-round flag under a coach bubble (`src/coachFeedback.ts`) reports one
wrong ANSWER, is keyed to its trajectory + round, and is eval signal. Beta
feedback reports the product. Different targets, different lifetimes — keep
both, and keep the copy distinct so the header icon doesn't read as a duplicate
of the flag.

## Storage

Follows the `coach_feedback` shape exactly: INSERT-only from the client, no
client SELECT, maintainer emailed by `notify-contribution` (a new `kind`, not a
new function) and reading rows in the SQL editor.

`beta_feedback.input_mode` is always `"text"`. It was added for a dictation
feature that has since been removed; the column stays because migrations are
append-only, and nothing writes anything else to it.

## Voice input was removed

Dictation shipped briefly (a native-only speech seam, `SpeechPlugin` on both
shells, a mic in the coach composer and this sheet) and was then taken out: too
much uncertainty for the value, and it dragged a microphone permission and two
store privacy declarations behind it.

If it ever comes back, the things that made it hard are worth knowing:

- **Web is not viable.** Chrome's `webkitSpeechRecognition` is not local — it
  streams audio to Google — and Firefox has none. Native-only was the only
  honest privacy story, which meant a permission on both shells for a feature
  the web build could not have.
- **One microphone means one session.** The feedback sheet opens *over* the
  coach chat, so two dictation consumers can be mounted at once; a second
  `start()` has to supersede the first and tell it so, or the first sits on a
  frozen partial whose Stop button stops the wrong session.
- **A settled utterance ends the session.** Both platform recognizers release
  the mic after a final result, so the UI must reset its listening state on an
  end callback, not on the user tapping stop.
- **iOS audio session.** `duckOthers` is only settable on
  `playAndRecord`/`playback`/`multiRoute` — pairing it with `.record` throws on
  every start. Permission must also be requested *before* availability is
  checked, since `SFSpeechRecognizer` reports unavailable while authorization is
  `notDetermined`.
- **Android's `ERROR_NO_MATCH` is not an error.** It is an ordinary pause, and
  surfacing it as a failure accuses the user of a broken feature.

The full history is in PR #228 and its review pass.
