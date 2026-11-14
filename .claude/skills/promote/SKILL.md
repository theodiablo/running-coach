---
name: promote
description: Move a released build to the stores' production tracks (Play production, App Store review) through promote-android.yml / promote-ios.yml, then flip the in-app update prompt with publish-version.yml once a store is live. Use when the maintainer types /promote [version] [android|ios|both], or "publish" for the last step.
disable-model-invocation: true
argument-hint: "[version] [android|ios|both] | publish [android|ios|both]"
---

# Promote a release

Invoking this skill IS the maintainer's ask to send a build to production
users, which `/ship` deliberately leaves out. It covers the version named in
the request, else the newest `v*` GitHub release; the platforms named, else
both. `/promote publish [platform]` does only step 6 (and the report).
Mechanics and every input: `docs/release.md` ("Promoting an Android
build", "Promoting an iOS build", "Upload ≠ publish").

## 1. Know what you are promoting

- The version's tag exists and its "Release mobile apps" run uploaded the
  platform: the `android` / `ios` job is green on that run. A platform whose
  upload failed is not promoted; say why and what unblocks it (see 5).
- Write the release notes once, for both stores: plain English a runner
  understands, what changed for them, no file names, PR numbers or internal
  terms; at most 500 characters (Play's cap; Apple's is 4000, so 500 binds
  both), `|` for a line break. Build them from the PRs merged since the
  previous tag (the GitHub release body lists them). The upload carries none,
  so blank would copy nothing, and App Store production refuses to submit
  with "What's New" empty (the app's very first App Store version is the one
  exception: it takes none). Show them in your report.

## 2. Android

Dispatch `promote-android.yml` on `main`: `from_track: internal`,
`to_track: production`, `rollout_percent: 100`, `release_notes`. Leave
`version_code` blank only when the newest completed internal release is this
version (a release dispatched after it would be picked instead); otherwise
pass it, read from that release run's Android job log or Play Console (it
folds in `run_attempt`, so a re-run upload has a higher code). A staged rollout (`rollout_percent` < 100) only when the maintainer
asks.

## 3. iOS

Dispatch `promote-ios.yml` on `main`: `target: production`, `version` named
explicitly (blank means "newest build App Store Connect already lists", which
right after a release is the previous one), `release_notes`,
`release_type: after_approval`. The job waits for processing
(`wait_minutes`, default 60). `testflight`, `phased_release`, `manual` or
`draft` only when asked.

## 4. Watch the runs

A dispatched run sends no PR event: check on each until it finishes (one
delayed check-in, `send_later`, or a background watch), never a polling loop.
Read a failed run's log before doing anything. A transient platform failure
(runner, network, store API 5xx) gets "Re-run failed jobs" once. A refusal is
not transient: another review submission in progress, a version already in
review, an empty What's New, Play rejecting the edit, an expired agreement.
Report it with the exact message and what clears it. Never dispatch again
over a refusal.

## 5. Blocked upstream

If the release run's upload for a platform failed, fix that first, never by
dispatching `release.yml` again for the same merge (it bumps the version and
re-ships the other store). A failure only the maintainer can clear (Apple's
"A required agreement is missing or has expired" = App Store Connect →
Business → Agreements; a revoked key or certificate) is reported with that
step; once they say it is done, "Re-run failed jobs" on the original release
run, then promote.

## 6. Publish (a separate, later ask)

Promotion is not publication: Play and App Store review come after it. Only
when the maintainer says a store is live (or asks for `/promote publish`),
dispatch `publish-version.yml` with that `platform`. A blank `version`
announces whatever is staged, and every release run overwrites the staged
version, so leave it blank only when the version being published is the
newest release on that platform; otherwise (an older version, a later
release staged since, a release whose staging step failed) pass it. That run is what
turns the in-app update card on. Never run it on a guess that review has
passed.

## 7. Report

One short message: per platform, what was dispatched (run link), where it
ended (in review, rolled out at N%, or blocked and on what), the release notes
used, and what is left: the publish step once the stores are live, or the
maintainer's action that unblocks a platform.
