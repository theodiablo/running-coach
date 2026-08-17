/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Where this build will actually be served from — a property of the DEPLOY, not
// a constant, which is why it is wired to env rather than hardcoded:
//
//   production web  '/'          bucket root            (deploy.yml, default)
//   PR preview      '/pr/<n>/'   subfolder              (deploy-pr.yml, VITE_BASE)
//   native shells   './'         local origin root      (release.yml)
//
// It must be an ABSOLUTE prefix anywhere a nested route is served. index.html is
// one static artifact and CloudFront's SPA fallback hands it to every unknown
// path, so a relative `./assets/…` silently means something different depending
// on the URL it was loaded from: correct at `/`, but at `/watch/<token>` it asks
// for `/watch/assets/…`, gets index.html back from the fallback, and the module
// is refused as `text/html`. Nothing runs then — not React, not the error
// boundaries, not the PostHog SDK — so it fails as a white page that reports
// nothing. `./` survives only where no nested route is ever served: the shells,
// which have no such URL at all.
//
// Note the fallback always returns the bucket ROOT index.html, ignoring the
// prefix, so a preview cannot serve `/watch/:token` at all — deep-link routing
// is a production-only property. Previews are entered at their index.html.
const base = process.env.VITE_BASE || (process.env.VITE_NATIVE_BUILD ? './' : '/')

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base,
  // Must not outrun the iOS deployment target (15.4): WKWebView's engine is the
  // OS version, so a shell on iOS 15 runs a Safari 15 JS engine. Vite's default
  // is `baseline-widely-available`, which resolves to ios16.4 — it was happily
  // emitting syntax (class static blocks) that iOS 15 cannot parse. The other
  // three legs keep that baseline; only the Safari/iOS legs move.
  // Syntax only: this lowers what it can, but nothing lowers a regex lookbehind
  // (scripts/check-bundle-regex.mjs catches those) or polyfills a missing API.
  build: { target: ['safari15.4', 'ios15.4', 'chrome111', 'edge111', 'firefox114'] },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
