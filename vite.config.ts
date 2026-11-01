/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Base is a property of the DEPLOY: web '/', PR preview '/pr/<n>/' (VITE_BASE), shells './'. It must be ABSOLUTE
// wherever a nested route is served: the SPA fallback hands index.html to every path, so a relative `./assets/` at
// `/watch/<token>` is refused as text/html (white page). Previews can't serve `/watch/:token` (fallback returns root).
const base = process.env.VITE_BASE || (process.env.VITE_NATIVE_BUILD ? './' : '/')

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base,
  // Must not outrun the iOS deployment target (15.4): WKWebView's engine is the OS version, and Vite's default
  // `baseline-widely-available` (ios16.4) emitted syntax iOS 15 can't parse. Only the Safari/iOS legs move.
  // Syntax only: nothing lowers a regex lookbehind (scripts/check-bundle-regex.mjs catches those) or polyfills APIs.
  build: { target: ['safari15.4', 'ios15.4', 'chrome111', 'edge111', 'firefox114'] },
  // jsdom boot dominated the suite's wall time, so only component suites (.tsx)
  // pay for it; a .ts suite that needs a DOM opts in with a
  // `// @vitest-environment jsdom` docblock.
  test: {
    globals: true,
    setupFiles: './src/test/setup.ts',
    projects: [
      { extends: true, test: { name: 'unit', environment: 'node', include: ['src/**/*.{test,spec}.ts'] } },
      { extends: true, test: { name: 'dom', environment: 'jsdom', include: ['src/**/*.{test,spec}.tsx'] } },
    ],
  },
})
