/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  // Must not outrun the iOS deployment target (15.0): WKWebView's engine is the
  // OS version, so a shell on iOS 15 runs a Safari 15 JS engine. Vite's default
  // is `baseline-widely-available`, which resolves to ios16.4 — it was happily
  // emitting syntax (class static blocks) that iOS 15 cannot parse. The other
  // three legs keep that baseline; only the Safari/iOS legs move.
  // Syntax only: this lowers what it can, but nothing lowers a regex lookbehind
  // (scripts/check-bundle-regex.mjs catches those) or polyfills a missing API.
  build: { target: ['safari15', 'ios15', 'chrome111', 'edge111', 'firefox114'] },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
