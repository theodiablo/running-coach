---
name: ship
description: Take a finished PR all the way out — independent review by one or more agents sized to the PR, fix what's verified, merge, then release the mobile apps when the change reaches them. Use when the maintainer says "/ship", "ship it", or asks to review + merge + release a PR.
---

# Ship a PR

Invoking this skill IS the maintainer's explicit ask to merge (the one
exception to CLAUDE.md's "never merge unless asked") and to cut a mobile
release. It covers the PR named in the request, else the open PR for the
current branch. Nothing else is implied: promoting a store build to
production and flipping the in-app update prompt stay separate asks.

## 1. Ready to review

The PR must be pushed, CI green on its head, no merge conflict. If not, drive
it there first (CLAUDE.md "Git / PR workflow").

## 2. Independent review

Size the review to the PR. Every reviewer is read-only (never edits, commits
or pushes) and gets: the diff command (`git diff origin/main...HEAD`), what
the PR is for, CLAUDE.md and the relevant `docs/` page, and the seams its
lens covers. Each reports findings with a concrete failure path, severity
(blocking / should-fix / nit), and what it checked and found fine.

- **Small, contained change** (one module, no native/server/data surface) →
  one reviewer.
- **Complex or sensitive work** → as many reviewers as the risk needs, in
  parallel, each with ONE distinct lens so they don't overlap: e.g. the core
  logic's correctness; JS ↔ native (Kotlin/Swift) or app ↔ edge-function
  parity; persistence and migration of synced data (`app_state`, settings
  blobs); security (RLS, auth callbacks, premium gating, secrets); copy and
  i18n rules; test gaps. Split a large diff by area when one agent can't
  hold all of it.
- Model per CLAUDE.md "Sub-agents": `opus` for security-sensitive review and
  anything adjudicating architecture or what a test protects; `sonnet` for
  the other lenses. A review that gates a release leans `opus` when unsure.

Merge the reports and drop duplicates before step 3.

## 3. Verify, then fix

Agents report false positives: re-check every finding against the code
yourself before acting.

- Real and in proportion → fix it, with a test that fails without the fix
  where one is feasible.
- Real but a product trade-off the maintainer already settled in the
  conversation → leave it, and say so in the final report.
- Not real → drop it, and say why in the report.

Run lint, typecheck and the full test suite, push, and wait for CI to be
green on the new head (the `apk` label builds native code a sandbox can't
compile — add it when the PR touches `android/`). A fix round that changes
behaviour gets a second, narrower review of the fix diff only.

## 4. Merge

Squash-merge (the repo's convention) with a title that says what changed for
the runner. Never merge a red, conflicted or unreviewed head.

## 5. Release the mobile apps

Only when the merged change reaches the apps — anything under `src/`,
`android/`, `ios/`, `public/`, `index.html` or the build config. Skip it for
docs-, infra-, supabase- or CI-only PRs, and say so.

Dispatch "Release mobile apps" (`release.yml`) on `main` with `bump: patch`
(minor/major only when the maintainer says so). It uploads to the Play
internal track and TestFlight and tags the version (`docs/release.md`). Watch
the run to completion; on a failure, diagnose and report — a failed platform
job is re-run with "Re-run failed jobs", never a second dispatch (store build
numbers can't be reused).

## 6. Report

One short message: what the review found and what was fixed or left (and
why), the merge commit, the release version and run link, and the next
manual steps — promote to production (`promote-android.yml` /
`promote-ios.yml`) and "Publish app version" once the stores publish. Offer
to run those; don't run them unasked.
