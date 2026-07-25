# Running Coach 🏃

> A free, open-source training app I built because I got tired of being nagged to upgrade.

**[→ Try it live at run.camboulive.solutions](https://run.camboulive.solutions)**

---

## Why this exists

I recently got into running and started preparing for a race. I just wanted a simple app to:

- Build a training plan around my race date and goal time
- Log my runs and track my progress
- Not get pestered about going Premium every five minutes

Spoiler: every app I tried failed the last point. Strava, I'm looking at you.

So I did what any reasonable person would do — I spent a weekend vibe-coding my own.

If you're in the same boat, **[sign up and give it a go](https://run.camboulive.solutions)** — it's free, no premium tier, no upsells. Ever.

You can also fork it, run your own copy, or suggest features. All feedback is welcome!

---

## Design philosophy: boring is good

The app is intentionally **100% static and serverless**:

- The entire thing is a React SPA that compiles to a handful of static files, deployed on S3 + CloudFront.
- Auth and per-user data (runs, plan, settings) are handled by [Supabase](https://supabase.com) — no custom backend, no server to patch.
- This keeps the attack surface tiny, the maintenance burden near zero, and the hosting cost close to nothing.

---

## Tech stack

- **React 19 + Vite** — the SPA itself
- **Tailwind CSS** — styling
- **Supabase** — auth + a single JSONB row per user for all app state
- **S3 + CloudFront** — hosting, deployed via GitHub Actions on every push to `main`

---

## Running your own copy

Want to fork this and make it yours? Here's everything you need.

### Prerequisites

- **Node 20+**
- A free **[Supabase](https://supabase.com)** account (the free tier is plenty)

### 1. Create a Supabase project

Go to [supabase.com](https://supabase.com), create a new project, then grab your
**Project URL** and **anon (public) key** from *Settings → API*.

### 2. Set up the database schema

In your Supabase project, open the **SQL Editor** and run **every** migration
file from `supabase/migrations/` in filename (timestamp) order — the list grows
over time, so don't rely on a snapshot of it. Highlights of what they set up:
the core schema + RLS (`init_schema`), GPS route traces (`run_routes`), the app
version gate for the in-app update prompt (`app_config`, plus the iOS columns
in `app_config_ios`), the shared races catalogue, and the AI-coach tables.

Alternatively, if you have the [Supabase CLI](https://supabase.com/docs/guides/cli)
and Docker installed, you can run a full local stack:

```sh
supabase start        # spins up a local Postgres + Auth + Studio
supabase db push      # applies migrations
```

### 3. Point the app at your Supabase project

Set your Supabase URL and anon key as Vite environment variables. For local
development, put them in `.env.local`; CI builds derive the URL from the repo
variable `SUPABASE_PROJECT_REF`.

```sh
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here
```

### 4. Run it

```sh
npm install
npm run dev
```

That's it — the app is fully self-contained once it talks to your own Supabase project.

### 5. Deploy (optional)

Pushes to `main` trigger `.github/workflows/deploy.yml`, which builds the app and
syncs `dist/` to an S3 bucket behind a CloudFront distribution. Set these
**repository secrets** in your fork (*Settings → Secrets and variables → Actions*):

| Secret | Value |
|--------|-------|
| `AWS_REGION` | e.g. `eu-west-3` |
| `AWS_DEPLOY_ROLE_ARN` | IAM role ARN assumable via OIDC from GitHub Actions |
| `S3_BUCKET_NAME` | target S3 bucket (serve as a static website or via CloudFront) |
| `CLOUDFRONT_DISTRIBUTION_ID` | distribution to invalidate after each deploy |
| `VITE_MAPTILER_KEY` | *(optional)* MapTiler key for the map basemap on GPS-tracked runs — see [Maps](#maps). Omit it and the app still records runs, just without tiles. |
| `VITE_POSTHOG_KEY` | *(optional)* PostHog project API key for analytics + crash reporting — see [docs/telemetry.md](docs/telemetry.md). Omit it and the app sends no telemetry at all. |

The workflow uses GitHub's OIDC provider to assume the IAM role — no long-lived
AWS credentials stored in GitHub. The role needs S3 write access and these
CloudFront permissions: `CreateInvalidation`, `ListResponseHeadersPolicies`,
`CreateResponseHeadersPolicy`, `GetResponseHeadersPolicy`,
`UpdateResponseHeadersPolicy`, `GetDistributionConfig`, `UpdateDistribution`.

---

## Local development commands

```sh
npm install           # install dependencies (run first after cloning)
npm run dev           # start the Vite dev server
npm test              # run the Vitest suite once
npm run test:watch    # watch mode
npm run lint          # ESLint
npm run build         # production build → dist/
npm run preview       # preview the production build locally
```

---

## Mobile apps (background GPS tracking)

The web app records runs only while the screen is on — browsers can't track in the
background. The **Android and iOS apps** wrap the same web build in
[Capacitor](https://capacitorjs.com) shells and swap the GPS source for a native
background-location plugin, so a run keeps recording with the screen off or the app
backgrounded. The UI, save path, and `run_routes` storage are reused unchanged; the
web app is unaffected (a single bundle serves all — `Capacitor.isNativePlatform()`
is `false` in the browser).

**Build Android locally** (needs Android Studio / the Android SDK + JDK 21):

```sh
npm install
npm run build              # → dist/
npx cap sync android       # copy web assets + native plugins into android/
npx cap open android       # open in Android Studio, run on a device/emulator
```

**Build iOS locally** (needs a Mac with Xcode 26+; the project is SPM-based — no
CocoaPods):

```sh
npm install
npm run build              # → dist/
npx cap sync ios           # copy web assets + rewrite CapApp-SPM/Package.swift
npx cap open ios           # open in Xcode, run on a device/simulator
```

Debug builds need no signing. Store releases are built by
`.github/workflows/release.yml` (manual or on a `v*` tag), which builds the web
bundle once and ships **both stores in parallel**:

- **Android** needs repository secrets `ANDROID_KEYSTORE_BASE64`,
  `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, and
  `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (a Play Developer API service-account JSON
  key; grant the account "Release to testing tracks" in Play Console → Users &
  permissions) for the Play upload (internal track — bump the step's `track` to
  `production` to ship to users).
- **iOS** needs an App Store Connect API key as secrets `ASC_API_KEY_P8_BASE64`,
  `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID`, plus the `APPLE_TEAM_ID` repo variable;
  signing is cloud-managed (`-allowProvisioningUpdates`) and the build lands in
  TestFlight. The key's role must be **Admin**: automatic provisioning
  creates/refreshes certificates and profiles, which App Manager keys aren't
  allowed to do (Apple gates certificate access to Admin / Account Holder).

The two store jobs are independent — one failing never blocks the other; re-run
just the failed job and it uploads with a fresh build number.

### Versioning & releases

Don't hand-edit the version — it's derived at build time, so a release is just a
tag (one tag ships both stores). Two ways to cut one:

- **From a phone / no desktop:** GitHub → **Actions → "Release mobile apps" →
  Run workflow** (works in a mobile browser). Leave the defaults to ship the
  next patch, or pick `minor`/`major`, or type an exact `version`. The workflow
  builds, uploads to both stores, and then **creates the `v*` tag and a GitHub
  Release** (auto-generated notes) for you. `dry_run: true` builds only — no
  upload, no tag. Needs `contents: write` for the workflow token (default under
  Settings → Actions → General → Workflow permissions).
- **From a desktop:** push the tag yourself — same jobs run:

  ```sh
  git tag v1.2.0 && git push origin v1.2.0
  ```

- **`versionName` / `MARKETING_VERSION`** (e.g. `1.2.0`) comes from the `v*` tag
  (or the version resolved by the manual run).
- **`versionCode` / `CFBundleVersion`** (what the stores order uploads by — must
  always increase) is `(run_number + 1000) * 1000 + run_attempt`, injected
  automatically so a rerun after a partial release still gets a fresh store build
  number. The `+1000` offset keeps the sequence above the codes the retired
  `android-v*` workflow already uploaded to Play. No manual bumping.
- Local/debug builds fall back to `1` / `1.0`.

### In-app update prompt

The app compares its installed `versionName` against the `app_config` row
(`supabase/migrations/20260623120000_app_config.sql`) on launch:

- `latest_version` / `latest_version_ios` — what the update banner compares
  against: users on an older version see a dismissible "update available"
  banner. **Not set automatically.** The release workflow only *stages* the
  uploaded version (below); you promote it when the store publishes.
- `pending_version` / `pending_version_ios` — set **automatically** by the
  release workflow after each store's *upload* succeeds (per-platform, so a
  partial release never stages a version a store didn't get). Uploading is not
  publishing — Play promotion/rollout and App Store review happen later — so
  staging alone never shows the banner. These two columns are excluded from the
  client SELECT grant (column-level privileges), so an unreleased version
  number is never readable by app clients.
- `min_supported_version` / `min_supported_version_ios` — **you bump these by
  hand** in Supabase only when you ship a breaking change; clients below them get
  a non-dismissible "update required" screen.

When a store actually publishes the build, run **Actions → "Publish app
version"** (`publish-version.yml`, phone-friendly like the release dispatch):
pick the platform (`android` / `ios` / `both`) and it promotes the staged
pending version to `latest_version(_ios)` — that's the moment outdated clients
start seeing the banner. A platform with nothing staged fails loudly (with
`both`, each platform is attempted independently, so a partial release still
publishes the store that shipped), every run ends by printing the resulting
`app_config` row, and an optional `version` input overrides the staged value
for repairs/rollbacks.

For the workflows to write these columns, configure the Supabase CLI credentials
(the same values used by the Edge Function deploy workflow):

| Name | Type | Value |
|------|------|-------|
| `SUPABASE_ACCESS_TOKEN` | Secret | a Supabase personal/service access token with database query rights on `run-app` |
| `SUPABASE_PROJECT_REF` | Variable | the Supabase project ref to link/query |

Both workflows use `npx supabase db query --linked` against the project in
repo variable `SUPABASE_PROJECT_REF` to update the `public.app_config` version
columns. The token is a CI/server secret only: never put it in `config.ts`, the app
bundle, or any `VITE_*` var. If either the secret or project-ref variable is
missing, a tagged release fails after the store upload instead of silently skipping
the pending-version staging.

### Install a build on your phone

Every PR builds a sideloadable **debug APK** via `.github/workflows/android-pr.yml`
(a bot comment links to it). To install one:

1. Download the `running-coach-pr<N>-debug-apk` artifact from the PR's workflow run
   and unzip it to get `app-debug.apk`. (Locally: `cd android && ./gradlew assembleDebug`
   → `android/app/build/outputs/apk/debug/app-debug.apk`.)
2. Get it onto the phone — easiest is `adb install app-debug.apk` over USB
   (enable **Developer options → USB debugging**), or transfer the file and tap it.
3. When tapping the file, Android asks to **allow installing unknown apps** for
   whichever app opened it (Files, Chrome, Drive) — allow it, then install.

The debug APK is signed with a throwaway debug key, so it can't be updated *over* a
Play Store install of the same app (uninstall one first). Background GPS, the
foreground-service notification, and the location prompts all work in debug builds —
no Play release or plugin license required.

> ⚠️ The PR APK uses the same `applicationId` (`solutions.camboulive.run`) and talks
> to the **production Supabase project** — runs you log from a test build are real
> data on your account.

**Before release**, three things must be configured outside the repo:

- **Supabase Auth → URL Configuration:** add `solutions.camboulive.run://auth-callback`
  to the redirect allow-list so OAuth / magic-link sign-in returns to the app.
- **MapTiler key origins:** the WebView's origin is **`https://localhost`**, not the
  web domain, so an origin-restricted key returns *"Invalid key"* and tiles won't
  load. Add `https://localhost` (and `http://localhost`) to the key's allowed
  origins in the MapTiler dashboard — see [Maps](#maps).
- **Play Console:** background location requires a prominent in-app disclosure, a
  public privacy policy URL, and the "Location permissions" declaration form
  justifying `ACCESS_BACKGROUND_LOCATION` (core feature: recording a run with the
  screen off). Test on an internal track first.

## Maps

Live GPS run tracking renders the route on a map using [MapTiler](https://www.maptiler.com/)
tiles. Without a key the tracker still records the run; only the map basemap
won't load (the app shows a small "needs key" notice instead of tiles). Raw
OpenStreetMap tiles are intentionally not used — the OSMF tile policy disallows
them for a multi-user app.

The basemap is a **built-in style slug** (`streets-v2`), set once in
`src/constants.ts` (`MAP_TILE_URL`). Built-in slugs ship pre-rendered raster
tiles on every plan (incl. free) and render with any valid key. A **custom**
MapTiler style (a UUID from cloud.maptiler.com) is *not* a drop-in swap: its
vector `style.json` serves for free, but its **raster** `.../256/{z}/{x}/{y}.png`
endpoint returns **403 on the free plan** — server-side rasterizing a custom
style is a paid feature. A custom decluttered style was tried and reverted for
this reason; to adopt one, either upgrade the MapTiler plan (then just point
`MAP_TILE_URL` at `.../maps/<id>/256/...`) or render it as vector via MapLibre
GL.

**Set the key as the `VITE_MAPTILER_KEY` build-time variable:**

- **CI / deploys:** add `VITE_MAPTILER_KEY` as a **repository secret**
  (*Settings → Secrets and variables → Actions*). Both `deploy.yml` and
  `deploy-pr.yml` read it in their build step and Vite inlines it into the
  bundle. The secret is read at build time, so a change only takes effect on the
  next deploy — re-run the workflow (or push a commit) after adding it.
- **Local dev:** put `VITE_MAPTILER_KEY=...` in a gitignored `.env.local` file.

> ⚠️ **A `VITE_*` value is NOT a secret in the deployed app.** Vite inlines it
> into the public JavaScript bundle, so anyone can read the key in their
> browser's dev tools — using a GitHub secret only keeps it out of the *source
> repo*, not out of the shipped site. The real protection is **restricting the
> key to your origin(s)** in the MapTiler dashboard
> (*Account → Keys → Allowed origins / HTTP referrers*): add your production
> domain (e.g. `https://run.camboulive.solutions`) so the key can't be lifted
> and used to drain your tile quota from another site. PR previews are served
> from the same origin, so one entry covers them too. Never use an unrestricted
> key here.
>
> **Android app:** the Capacitor WebView loads from `https://localhost`, *not* the
> web domain, so a key restricted only to the production domain returns
> *"Invalid key"* and tiles won't render (the run still records). Add
> `https://localhost` (and `http://localhost`) to the allowed origins so the app's
> map works too.

## Security

- A Content-Security-Policy is set in `index.html` as defence-in-depth.
- `.github/workflows/security.yml` runs Semgrep on every PR and push to `main`.
- The MapTiler key (`VITE_MAPTILER_KEY`) is inlined into the public bundle, so it
  must be **origin-restricted in the MapTiler dashboard** to your domain(s) — see
  [Maps](#maps). No default key ships in the source.
- Password policy lives in `supabase/config.toml` for local dev; the live project's
  policy must be set in the Supabase dashboard.

---

## Your data

When you sign up, the app stores (in your own RLS-isolated rows):

- Your email address (for login)
- Your runs (date, distance, duration, HR, effort, notes) and GPS routes
- Your training plan and race settings
- Your name, if you enter one during onboarding

No ads, ever. I will never sell your data or use it for anything other than running the app.

**Analytics & crash reporting.** If the app is built with a PostHog key
(`VITE_POSTHOG_KEY`), it can send a small set of product-usage events (e.g. a run
was logged, a plan generated) and crash reports — processed by
[PostHog](https://posthog.com) (EU hosting) as a sub-processor, to help fix bugs
and see what's used. It does **not** send your run contents, routes, notes, or
HR. This is **opt-in**: nothing is collected until you accept the consent banner
shown on first visit — decline and it stays fully off. You can change your mind
any time in **Settings → Privacy** (the choice is remembered per device). On the
Android app, every crash also asks before it's sent. Builds without the key send
nothing at all.

The app is open source — you can read exactly what gets stored in
`supabase/migrations/` and `src/db.ts`, and exactly what telemetry is sent in
`src/telemetry/`.

The workflow uses GitHub's OIDC provider to assume an AWS IAM role
(`aws-actions/configure-aws-credentials`) — no long-lived AWS keys stored in
GitHub.

### PR previews

`.github/workflows/deploy-pr.yml` deploys a preview for each pull request to its
own prefix in the same bucket — `s3://<bucket>/pr/<number>/`, served at
`https://run.camboulive.solutions/pr/<number>/index.html` — and removes it when
the PR is closed. The deployed URL is posted (and kept up to date) as a PR
comment. (CloudFront only resolves a default root object at `/`, so previews
link straight to `index.html`.)

Every PR gets one regardless of its base branch, so a stacked PR (based on
another PR's branch rather than `main`) is previewable too — each one has its
own `/pr/<number>/` prefix, so a whole stack can be open at once.

Only the **code owners** listed in `.github/CODEOWNERS` trigger a preview: the
job is gated on the PR author having write access (`OWNER`/`MEMBER`/
`COLLABORATOR`), and because the workflow uses `pull_request` (not
`pull_request_target`), fork PRs cannot assume the deploy role. It reuses the
same OIDC role and CloudFront distribution as the production deploy.

---

## License

[MIT](LICENSE) — do whatever you want with it, just keep the copyright notice and give a shoutout to the original project if you reuse it.
