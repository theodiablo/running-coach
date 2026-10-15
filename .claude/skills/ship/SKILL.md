---
name: ship
description: Take a finished PR all the way out — independent review by one or more agents sized to the PR, fix what's verified, merge, then release the mobile apps when the change reaches them. Use when the maintainer types /ship [PR number].
disable-model-invocation: true
argument-hint: "[PR number]"
---

# Ship a PR

Invoking this skill IS the explicit ask CLAUDE.md's "Never merge a PR unless
explicitly asked" requires, and the ask to cut a mobile release. It covers
the PR named in the request, else the one open PR for the current branch; if
neither resolves to a single PR, ask. Nothing else is implied: promoting a
store build to production and flipping the in-app update prompt stay
separate asks.

## 1. Ready to review

Check out the PR head and `git fetch origin main`. The PR must be pushed, CI
green on its head, no merge conflict; if not, drive it there first (CLAUDE.md
"Git / PR workflow"). If it touches native code — `android/`, `patches/`,
`package.json`/`package-lock.json` or `capacitor.config.json` — add the `apk`
label and wait for that build too: it is the only Gradle/R8 build before the
release, and a sandbox can't run one.

Wait on CI through PR events (`subscribe_pr_activity`, then end the turn), not
scheduled check-ins.

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
- Real but needing the maintainer's call, or out of proportion → ask
  (`AskUserQuestion`) before merging.
- Not real → drop it, and say why in the report.

Run `npm run lint`, `npm run typecheck:all` and `npm test` (plus
`npm run infra:validate` when `infra/` changed), push, and wait for CI to be
green on the new head (step 1's `apk` rule applies to the fixes too). A fix
round that changes behaviour gets a second, narrower review of the fix diff
only.

## 4. Merge

Squash-merge (the repo's convention) with a title that says what changed for
the runner, then `unsubscribe_pr_activity`. Never merge a red, conflicted or
unreviewed head, or one with an unresolved blocking finding.

## 5. Release the mobile apps

Only when the merged change reaches the apps: `src/` (tests excepted),
`android/`, `ios/`, `public/`, `index.html`, `vite.config.ts`,
`capacitor.config.json`, `package.json`/`package-lock.json`, `patches/`, or a
`supabase/functions/_shared/` module the app imports
(`grep -rl functions/_shared src`). Skip it for docs-, infra-, migration-,
edge-function-only, CI- or test-only PRs, and say so.

First check the "Release mobile apps" runs for one already on this merge
commit (a re-invoked `/ship` or a resumed session); if there is one, watch it
instead. Otherwise dispatch `release.yml` on `main` with `bump: patch`
(minor/major only when the maintainer says so). It uploads to the Play
internal track and TestFlight and tags the version (`docs/release.md`).

A dispatched run on `main` sends no PR event: check on it until it finishes
(one delayed check-in or a background watch). A transient platform failure
(runner, network, store API) is retried with "Re-run failed jobs", which
folds `run_attempt` into the build number so the stores accept it. Never
dispatch again for the same merge: once one store shipped, the tag exists,
and a new dispatch bumps the version and re-ships both stores. A failure that
needs a code fix is diagnosed and reported, not retried.

## 6. Report

One short message: what the review found and what was fixed or left (and
why), the merge commit, the release version and run link, and the next
manual steps — promote to production (`promote-android.yml` /
`promote-ios.yml`; name the `version` when promoting iOS right after a
release) and "Publish app version" once the stores publish. Offer to run
those; don't run them unasked.
