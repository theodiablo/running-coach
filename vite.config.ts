/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The shells load the bundle off a local origin, where a relative base is the
// safe default; the web deployment must NOT use one. `base: './'` emits
// `<script src="./assets/index-<hash>.js">`, which the browser resolves against
// the *current path* — fine at `/`, fatal at `/watch/<token>`, where it asks for
// `/watch/assets/…`, CloudFront's SPA fallback answers with index.html, and the
// module is refused as `text/html`. No JS runs at all, so the page is white AND
// invisible to telemetry (the PostHog SDK is inside the script that never ran).
// A root-relative base resolves the same from every path depth, which is what
// the app's one nested route needs.
const base = process.env.VITE_NATIVE_BUILD ? './' : '/'

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
