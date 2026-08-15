# Releases, versioning & CI

How native releases ship, how versions gate updates, how edge functions deploy,
and how CI caching is laid out. Moved out of CLAUDE.md; keep this current when
touching `release.yml`, signing, or the CI workflows.

## Cutting a release

One platform-agnostic `v*` tag (e.g. `v1.4.0`) triggers `release.yml`, which
builds the web bundle once and ships **both** stores in parallel — an `android`
job (AAB → Play internal track) and an `ios` job (xcodebuild archive →
TestFlight).

Two ways to cut a release, both landing in the same build+upload jobs:

1. **`workflow_dispatch`** — the mobile / no-desktop path. Open Actions →
   "Release mobile apps" → **Run workflow** (works in a phone browser at
   github.com; the GitHub *mobile app* can't dispatch). The `prepare` job
   auto-computes the next version from the latest `v*` tag (`bump` input:
   patch/minor/major, default patch; or type an exact `version`), builds +
   uploads, then the final `tag` job **creates the `v*` tag and a GitHub
   Release with `--generate-notes`**. `dry_run: true` builds only (no upload,
   no tag) — the cheap way to validate a signing change.
2. **Pushing a `v*` tag** from a desktop — same jobs; `prepare` reads the
   version from the ref and `tag` attaches a Release to it.

A tag created by the workflow's `GITHUB_TOKEN` does **not** recursively
re-trigger the `push: tags` path (GitHub suppresses that), so a dispatch
release runs exactly once; the `tag` job needs `permissions: contents: write`.

`prepare.outputs.is_release` (false only for a dry run) is the single switch
every store-upload / Supabase-publish step gates on — it replaced the old
per-step `startsWith(github.ref, 'refs/tags/v')` checks, so those must keep
reading `needs.prepare.outputs.is_release`, and the version name for every job
comes from `needs.prepare.outputs.version` (don't reintroduce per-job ref
parsing).

## iOS signing (fully MANUAL distribution signing)

Both the archive and the export sign with a manually created Apple
Distribution certificate (a .p12 imported into a temp keychain:
`APPLE_DIST_CERT_P12_BASE64` / `APPLE_DIST_CERT_PASSWORD` secrets; mint/renew
it Mac-free with `npm run ios:dist-cert`, certs last 1 year and expiry only
blocks new uploads) against **App Store provisioning profiles regenerated on
every run** by `scripts/ios-appstore-profile.mjs`
(`npm run ios:appstore-profile`; step "Create App Store provisioning
profiles") — TWO of them since the Live Activity widget extension landed: the
app's ("Running Coach App Store CI", bundle `solutions.camboulive.run`) and
the widget's ("Running Coach Widget App Store CI",
`solutions.camboulive.run.widgets`, whose ASC bundle-id record the script
auto-registers if missing). The script uses the SAME ASC API key
(`ASC_API_KEY_P8_BASE64` / `ASC_API_KEY_ID` / `ASC_API_ISSUER_ID` secrets +
`APPLE_TEAM_ID` repo var) to create `IOS_APP_STORE` profiles bound to the
team's live distribution certs and installs them locally; the archive then
pins `CODE_SIGN_STYLE=Manual` / `CODE_SIGN_IDENTITY="Apple Distribution"` on
the CLI, while **`PROVISIONING_PROFILE_SPECIFIER` lives per-target in the
pbxproj Release configs** — a CLI override is global across targets and would
force one profile onto both bundle ids, so never reintroduce it on the archive
command. The `IOS_BUNDLE_ID` / `APPSTORE_PROFILE_NAME` /
`IOS_WIDGET_BUNDLE_ID` / `WIDGET_PROFILE_NAME` job envs feed the profile
script + exportOptions `provisioningProfiles` map — keep them in sync with the
pbxproj `PRODUCT_BUNDLE_IDENTIFIER` + `PROVISIONING_PROFILE_SPECIFIER` values
and the script defaults.

**Why manual, not Xcode automatic signing (the bug that broke a release):**
automatic signing on an ephemeral runner has an empty keychain, so
`-allowProvisioningUpdates` minted a fresh **Apple Development** certificate on
EVERY archive; those accumulated until the team hit Apple's certificate cap and
the archive failed with "reached the maximum number of certificates" → "No
profiles … found". Manual distribution signing reuses the imported .p12 and
never creates a certificate; App Store profiles are NOT capped, so regenerating
one per run is free. Do NOT reintroduce automatic signing /
`-allowProvisioningUpdates` on the archive. (The old "don't force
`CODE_SIGN_IDENTITY` — conflicting provisioning settings" gotcha only applied
to forcing an identity while the STYLE stayed Automatic; with the style also
pinned to Manual there is no conflict.)

Other iOS signing gotchas, all hit in practice:

- The ASC key must have the **Admin** role (App Manager fails with "Cloud
  signing permission error").
- Apple's cloud-managed "Distribution Managed" certificate is REJECTED by App
  Store Connect ("Invalid Signature") on apps with embedded frameworks (all
  Capacitor apps — hence the manual .p12).
- Upload validation demands `NSHealthUpdateUsageDescription` in Info.plist even
  though the app never writes to Health — HealthKit framework presence alone
  triggers it, so keep that key when touching Info.plist.

## Build numbers & the update gate

Build version is NOT in the DB — versionCode/CFBundleVersion is
`run_number*1000 + run_attempt`, versionName/MARKETING_VERSION is the `v*` tag
(`android/app/build.gradle` reads env; iOS gets xcodebuild command-line
overrides). The `run_attempt` term matters: BOTH stores permanently reject a
re-used build number, and a bare `run_number` repeats on "re-run failed jobs" —
exactly what happens after a partial release. Seen in practice: run 45's retry
re-sent versionCode 45 and Play rejected it outright.

The two platform jobs are independent, so one store's failure never blocks the
other; each job STAGES its OWN `app_config` pending column (`pending_version`
for Android, `pending_version_ios` for iOS) only after its upload succeeds, so a
partial release never stages a version a store didn't get.

Both those steps and `publish-version.yml` reach the database through
`scripts/supabase-query.sh` (Management API `POST
/v1/projects/{ref}/database/query` with `SUPABASE_ACCESS_TOKEN`), **not** the
Supabase CLI. `supabase link` / `db query --linked` fetch the project's API keys
first and abort on a key whose `inserted_at` isn't RFC3339-with-`Z` (`failed to
get api keys: SchemaError(...)`) — that killed staging in release run 45 after
both stores already had the build. Keep new `app_config` writes on the script.
A release whose staging step failed is repaired by running "Publish app version"
with the explicit `version` input once the store publishes.

**Upload ≠ publish:** staging never shows the in-app update banner (Play
promotion/rollout and App Store review come after upload). The maintainer runs
the manual **"Publish app version"** workflow (`publish-version.yml`,
`workflow_dispatch`, phone-friendly) per platform once the store actually
publishes — it promotes pending → `latest_version(_ios)` (refusing when nothing
is staged; optional `version` input overrides for repair/rollback), and only
THAT flips the update prompt on. Don't reintroduce a direct `latest_version`
write in `release.yml`. `min_supported_version` / `min_supported_version_ios`
(hard gates) are bumped by hand on a breaking change.

`App.tsx` selects all four columns and compares the installed version
(`App.getInfo()`) against its platform's pair via `versionStatus`
(`src/utils/version.ts`); a failed check never blocks the user. iOS store links
need `APP_STORE_URL` (`src/constants.ts`) filled in once the App Store record
exists — the update prompt hides its button while it's empty.

**Gotcha — never open the store link through `@capacitor/browser` on Android**
(tapping "Update" crashed the app on-device): the plugin's Custom Tabs path
only catches `ActivityNotFoundException` natively, so any other failure
launching the tab kills the process. `openStore` (`UpdatePrompt.tsx`) instead
does a plain top-frame navigation — Capacitor's WebViewClient intercepts
external hosts (`Bridge.launchIntent`) and hands them to the OS as an
`ACTION_VIEW` intent, which the Play Store app claims. Use the same pattern for
any future Android outbound link that a native app should claim; `Browser.open`
stays correct for iOS (SFSafariViewController, as in OAuth).

## Deploying Supabase edge functions

**On merge to `main` this is automatic** —
`.github/workflows/deploy-supabase-functions.yml` diffs the push against the
previous commit and runs `supabase functions deploy <name>` (the CLI, reading
straight off disk) for whichever function directories changed, redeploying
`coach-agent` if `_shared/**` changed too. Needs a `SUPABASE_ACCESS_TOKEN` repo
secret (deploy rights on `run-app`) and a `SUPABASE_PROJECT_REF` repo variable.

**Mid-session (before a merge), deploy via the Supabase MCP tools, not the
CLI.** The project is **`run-app`**; use the project ref from the repo variable
`SUPABASE_PROJECT_REF` rather than hardcoding it. To redeploy `coach-agent`
after editing `supabase/functions/coach-agent/index.ts` or any
`supabase/functions/_shared/coach/*.mjs`, go straight to
`mcp__Supabase__deploy_edge_function` with that project id,
`name: "coach-agent"`, `entrypoint_path: "source/index.ts"`,
`verify_jwt: true`, and a `files` array of **exactly these eight**, read fresh
off disk (content must match current `git` state):

- `source/index.ts` ← `supabase/functions/coach-agent/index.ts`
- `_shared/coach/engine.mjs`, `_shared/coach/validation.mjs`,
  `_shared/coach/tools.mjs`, `_shared/coach/mock.mjs`,
  `_shared/coach/styles.mjs`, `_shared/coach/runDigest.mjs`,
  `_shared/coach/mistral.mjs` (same relative names, read from
  `supabase/functions/_shared/coach/`).

Omitting `styles.mjs` breaks the function at boot — `tools.mjs` imports it;
likewise `runDigest.mjs` and `mistral.mjs`, both imported by the entrypoint.
This naming is load-bearing: the entrypoint's `../_shared/coach/*.mjs` imports
only resolve because `_shared` sits as a sibling of `source/` in the upload,
mirroring the real `supabase/functions/` layout. No `list_edge_functions` /
`get_edge_function` round-trip needed first — the recipe is confirmed working.
`notify-contribution`, `polar-import`, and `route-suggest` are the other
JWT-verified functions; redeploy each the same way with its own single
`source/index.ts` (no `_shared` dependency).

**`live-watch` and `live-publish` are the two exceptions: deploy them with
`verify_jwt: false`.** One serves the public `/watch/:token` page to people
who have no account; the other is the native screen-off uploader, whose
foreground service holds a publish token, not a JWT. A deploy that quietly
takes the default breaks share links (401) or silently stops screen-off
uploads. The CLI reads this from the `[functions.*]` entries in
`supabase/config.toml`; an MCP deploy has to be told explicitly. Each also
needs its `_shared` contract alongside `source/index.ts` (same sibling layout
as `coach-agent` above): `liveShare.mjs` for `live-watch`, `livePublish.mjs`
(which itself imports `liveShare.mjs` — upload both) for `live-publish`.
`live-publish` additionally needs the `20260805062612_live_runs_publish_token`
migration applied (`supabase db push`) or it answers 500 by design. See
`docs/live-sharing.md` for the capability model.

Large payloads occasionally drop the MCP connection mid-call (~60KB of files) —
retry `deploy_edge_function` verbatim; it's a transient reconnect. The remote
sandbox's outbound proxy blocks arbitrary domains (`supabase.co` included), so
a post-deploy `curl` smoke test isn't possible there — confirm via the deploy
call's returned `status: "ACTIVE"` and, for request-level confirmation,
`mcp__Supabase__get_logs` with `service: "edge-function"`.

## Supabase Auth email templates (manual sync)

The transactional emails Supabase Auth sends (confirm signup, reset password,
**change email address**) are **project configuration, not migrations** — no
workflow, migration or MCP tool deploys them. Source of truth lives in
`supabase/templates/*.html`, wired into `supabase/config.toml` under
`[auth.email.template.*]` / `[auth.email.notification.*]`, which is what
`supabase start` uses locally. The two sections resolve `content_path` from
**different bases** — `[template]` from the directory the CLI runs in (the repo
root, so `./supabase/templates/x.html`), `[notification]` from the config file's
own directory (so `./templates/x.html`). Copying one convention onto the other
breaks *every* CLI command that loads the config, including the release
workflow's version-staging step, which runs after the stores are published;
`src/supabaseConfig.test.ts` fails CI on a path that doesn't resolve. The hosted
project reads only what's in
**Dashboard → Authentication → Emails**, so after changing a template file,
paste the same body (and subject) into the matching dashboard template — and
flip the matching toggle where one exists. Nothing warns you if you forget: the
change simply never reaches a real user.

### The email-change pair

Two templates, and the settings they depend on, must move together:

| File | Dashboard template | Sent to |
|---|---|---|
| `email_change.html` | Change Email Address | the **new** address — the confirmation link |
| `email_changed_notification.html` | Email Changed Notification (needs its toggle **on**) | the previous address — after the fact, no link |

This shape is deliberate. **Secure email change (`double_confirm_changes`) is
OFF**: with it on, GoTrue sends the *same* `email_change` template to both
addresses with a different one-time link in each and cannot tell the template
which recipient it is rendering for, so a user gets two identical-looking mails
and the change lands only after both links — which reads as "why two emails, and
why did clicking one do nothing?". The `email_changed` notification restores the
security property that removed (the old address still hears about the change)
without adding a second thing to act on.

If you ever turn `double_confirm_changes` back on, `email_change.html` and the
app copy in `src/i18n/locales/*/settings.json` (`emailConfirmNote`,
`emailPending`) both become wrong — they name a single inbox. Test any change by
running the real flow: Settings → Account → Change, open the link in the new
inbox, and confirm the notification arrives at the old one.

## CI caching & budget

- **All workflows use Node 22** (Capacitor 8 CLI floor) — keep new workflows on
  22 so they share one npm cache key family.
- **Android — the cache is seeded from `main`, read everywhere else.** GitHub
  scopes each ref's Actions cache to itself; a run may restore only its own
  ref's cache **plus the default branch's**. So `android-main.yml` builds
  Android on push to `main` (`gradle/actions/setup-gradle` writing, since it's
  the default branch) to seed the Gradle dep + task-output build cache;
  `android-pr.yml` and `release.yml` run setup-gradle with **no
  `cache-read-only` override** (its default is read-only off the default
  branch) so they *consume* that seed. Do NOT set `cache-read-only: false` on
  the PR/release jobs — that makes each PR/tag write its own private cache
  instead of sharing main's. A brand-new PR before main has seeded is cold
  once, then warm. `android/gradle.properties` enables `caching`/`parallel`
  with a 4 GB heap but **not** `configuration-cache`: setup-gradle only
  persists config-cache state with a `cache-encryption-key`, so it was pure
  overhead in CI (opt in locally instead).
- **iOS:** SPM clones are pinned to `ios/SourcePackages`
  (`-clonedSourcePackagesDirPath`, gitignored) and cached via `actions/cache`
  keyed on the repo name + the *synced* `CapApp-SPM/Package.swift` — the cache
  step must stay AFTER `npx cap sync ios`, which rewrites that manifest, and
  the repo name is in the key because SwiftPM bakes the runner's absolute
  workspace path (`/Users/runner/work/<repo>/<repo>`) into `SourcePackages`
  state, so a cache surviving a repo rename fails the archive with "no
  XCFramework found at" the old path. There is **no** `main`
  iOS seed (macOS minutes bill ×10, and `ios-pr.yml` is path-filtered to
  `ios/**`), so the SPM cache is same-ref only. Deliberately no DerivedData
  caching (unreliable invalidation, big caches, small win).
- Repo is private → free tier: 2,000 min/mo (macOS ×10), 10 GB Actions cache
  (LRU-evicted), 500 MB artifact storage — PR APKs use `retention-days: 14` to
  stay clear of the storage cap.
- **PR APK builds are opt-in via the `apk` label** (`android-pr.yml`): the job
  is skipped unless the PR carries the label (it was ~34% of all billable
  Actions minutes when it ran on every push). Add the label to get a
  sideloadable debug APK, rebuilt on every subsequent push while it stays set;
  `workflow_dispatch` bypasses the gate. Semgrep likewise runs on PRs only —
  deliberately not re-run on push to main (pure duplicate spend).
