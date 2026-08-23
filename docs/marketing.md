# Marketing landing, SEO & brand

The signed-out **web** experience (`src/marketing/`), its SEO strategy, and the
brand mark. Moved out of CLAUDE.md; keep this current when touching marketing.

## Entry gate & the web-only chunk

`src/App.tsx` branches once on the auth session. Signed-out **web** visitors get
the marketing landing (`src/marketing/MarketingGate.tsx`, a `lazy` chunk) which
opens the existing `LoginScreen` in a full-screen modal; signed-out **native**
goes straight to `LoginScreen`.

The lazy `MarketingGate` is wrapped in `ChunkLoadBoundary`
(`src/components/ChunkLoadBoundary.tsx`) whose fallback is the
statically-imported `LoginScreen`: a signed-in session never fetches the
marketing chunk, so **sign-out** is the first time it loads, and a stale chunk
after a mid-session redeploy (or a network drop) would otherwise reject the
dynamic import straight into the app-wide `ErrorBoundary` and white-screen the
app. The boundary swallows only chunk-load errors and re-throws genuine render
bugs so they still reach `ErrorBoundary`. Keep any future top-level `lazy()`
gate behind this same pattern.

The runtime split is `isNative`; the **build-time** exclusion is
`import.meta.env.VITE_NATIVE_BUILD` (set `"1"` only in `release.yml`'s
web-build job and the native PR workflows) — it constant-folds `MarketingGate`
to `null` so Rollup drops the whole marketing chunk from the APK/IPA (verified:
zero marketing bytes in a native build). Keep anything web-only-and-heavy
behind this same flag rather than a bare `isNative` runtime check, which still
ships the code inside the APK.

## Landing content

- Visual design is ported from the committed reference in
  `Marketing Page Design/` (a design-tool `.dc.html` export + screenshots —
  reference only, not built).
- **Self-hosted Archivo** font (`@fontsource/archivo`, imported inside
  `MarketingGate` so the woff2s live in the web-only chunk and never hit the
  APK or need a Google-Fonts CSP entry) and real app **screenshots** in
  `src/marketing/assets/`.
- The hero phone frame shows `CoachChatMock`, a hand-built propose-and-confirm
  chat exchange (kept honest: the coach only *proposes*; Apply is the user's) —
  the AI coach leads the page per user feedback, and the mock avoids the
  beginner skew of the old home-screenshot hero (First-5K badge, "walk breaks
  welcome"). Purpose-built mocks like it and `LiveTrackerMock` are the pattern
  when no suitable screenshot exists — screenshots are captured manually
  on-device, no retake tooling. (`BottomNav` is no longer overlaid in the
  marketing mock but stays an extracted shared component.)
- CTAs open `LoginScreen`; a secondary CTA links to the Play Store closed test
  (`PLAY_STORE_BETA_URL`); iOS beta CTAs use the public TestFlight opt-in
  (`TESTFLIGHT_BETA_URL`).

## Copy commitments (keep true)

- Methodology names on the plan card; the "no black box" session-breakdown line.
- The import strip: Strava/Garmin/Zepp via GPX/TCX/CSV *files* — never the
  Strava API; watch sync via Apple Health / Health Connect; **Polar** is the
  one direct *account* connect — keep Strava on the file side of that line.
- The free-tier "daily fair-use limit" phrasing is deliberately non-numeric
  (`RATE_LIMIT_PER_DAY` is env-configurable).
- The free wording is "everything you need to train is free" — deliberately NOT
  "free includes everything", so a future premium tier of *new* features never
  contradicts the page; don't reintroduce the absolute phrasing. See
  `docs/monetization.md` — durably: the app stays free; a future paid tier
  comes from *new* proactive-coach features, never from gating an existing free
  feature or lowering `RATE_LIMIT_PER_DAY` (the daily limit is cost-insurance,
  not a paywall lever).
- The footer carries a tip-jar link (`TIP_JAR_URL` in `src/constants.ts`, Buy
  Me a Coffee; empty string hides it) — it must only ever render inside the
  marketing chunk (web-only by construction): Apple rejects external payment
  links in the iOS app, so never surface it in native UIs.
- Marketing copy uses formal `vous` in French (the app-copy informal-`tu` rule
  applies to `src/i18n/` locales, not `src/marketing/`) — the ONE exception is
  the tip-jar link (`footer.support`, "Paye-moi un café"), deliberately
  informal `tu` because it's the developer's personal aside, not product copy;
  don't "correct" it back to `vous`.

## SEO (build-time only)

Static S3/CloudFront, no SSR; CSP `script-src 'self'` forbids the
inline-script pre-paint trick, so body content can't be prerendered into
`#root` without a flash for signed-in users. The strategy lives in
`index.html`:

- Rich `<head>` (title, description, canonical, Open Graph + Twitter, JSON-LD —
  `application/ld+json` is a non-executable data block so it's exempt from the
  script-src CSP) for search snippets + social cards.
- A `<noscript>` marketing fallback for non-JS crawlers (flash-free — JS
  visitors never see it, `#root` stays empty until React mounts). Googlebot
  additionally renders the client marketing (`src/marketing/`).
- `robots.txt` + `sitemap.xml` + `og-image.png` are in `public/`.

The OG image is a static 1200×630 PNG generated from
`scripts/og-image/template.html` filled with the shared
`src/marketing/copy.json` (the single source of truth for the brand + hero
headline — `MarketingGate.tsx` imports the same file, so the card can't drift
from the page). Regenerate locally with `npm run og:image` (needs a
Chrome/Chromium binary; found via `CHROME_BIN`, a Playwright chromium, or
system paths); CI does it automatically — `og-image.yml` re-renders and commits
the PNG on any change to `copy.json` or `scripts/og-image/**` on a feature
branch, so the refreshed card reaches `main` with the copy change. Never
hand-edit the committed PNG.

All three web-only SEO assets are `rm`'d in `release.yml`'s web-build job
before the per-platform `cap sync`s so they don't bloat the native packages.

If robust non-Google crawling or LCP from static content is ever needed, the
next step is bot dynamic rendering (CloudFront function) or splitting marketing
to its own path — not prerendering into the shared `#root`.

## Brand mark ("Pulse Stride")

The logo is a heartbeat/pulse line rising into a finish dot (`polyline` + end
`circle`, viewBox `0 0 220 120`). The one source for in-app/web usage is
`src/components/BrandLogo.tsx` (inline SVG, `currentColor` — set colour with a
text class); used by the app header (`RunningCoach`), `LoginScreen`, and
`MarketingGate`.

The **app-icon** variant is the mark in dark navy (`#0B1220`) on an orange
background:

- `public/favicon.svg` (rounded square, browser tab);
- the Android **adaptive** launcher icon
  (`drawable-v24/ic_launcher_foreground.xml` vector +
  `@color/ic_launcher_background` = `#F97316`; the adaptive icon is all that's
  used since `minSdk 26`, so the legacy `mipmap-*/ic_launcher*.png` rasters are
  dead fallbacks);
- the Play Store 512 icon (`store-assets/play-store-icon.svg` → full-bleed
  square PNG via `npm run store:icon`; Play applies its own mask);
- the iOS app icon (the same script also renders the 1024px opaque PNG into
  `ios/App/App/Assets.xcassets/AppIcon.appiconset/`; iOS applies its own mask,
  and App Store Connect rejects icons with alpha).

- the Android **launch window**
  (`drawable/splash_logo.xml`, the mark in orange `#F97316` on
  `@color/splash_background`).

Keep all of these in sync if the mark changes. The iOS launch screen is a solid
`#0f172a` frame in `LaunchScreen.storyboard`, matching the Android launch
window (`drawable/splash.xml`, wired into `AppTheme.NoActionBarLaunch`). That
theme is never swapped, so it is the window behind the WebView for the whole
session, not a flash: it shipped as Capacitor's stock white splash art with the
Capacitor logo, which users on slower phones sat looking at for seconds on every
launch. `@capacitor/splash-screen` is **not installed** — a `plugins.SplashScreen`
block in `capacitor.config.json` configures nothing and is what made that art
look intentional; the theme and `drawable/splash.xml` are the whole mechanism.
