import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// Sets window.__NATIVE_SHELL__ inside the Capacitor shell before the app renders
// (no-op in the browser). Imported first so the flag is ready for everything.
import './native'
// Captures a Polar OAuth `?code=` return and strips it BEFORE the Supabase
// client (imported via ./App below) can consume it as its own PKCE code. Must
// stay above ./App. No-op on every normal load. See src/polarPreinit.ts.
import './polarPreinit'
import { initI18n, detectInitialLocale } from './i18n'
import { initTelemetry, installGlobalErrorHandlers } from './telemetry'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ChunkLoadBoundary } from './components/ChunkLoadBoundary'
import { parseWatchToken } from './live/shareLink'
import App from './App'

// The app's one route. `/watch/:token` is a public page for people who may have
// no account at all, so the branch has to happen BEFORE <App/> mounts: App's
// first effects resolve the auth session and load the per-user store, and none
// of that has any business running for a stranger following a shared link.
//
// Native builds never serve it — the shells load the bundle from a local origin
// and have no such URL — so VITE_NATIVE_BUILD constant-folds this to null and
// Rollup drops the chunk from the APK entirely (same pattern as MarketingGate).
const PublicWatch = import.meta.env.VITE_NATIVE_BUILD
  ? null
  : lazy(() => import('./watch/PublicWatch'))
const watchToken = PublicWatch ? parseWatchToken(window.location.pathname) : null

// Start telemetry (no-op until a provider is wired in and the user consents)
// and catch foreground errors that escape React. Both honour the consent flag.
initTelemetry()
installGlobalErrorHandlers()

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

// A failed chunk fetch falls back to the app rather than a white screen: the
// visitor lands on the marketing page, which is a worse answer than the run
// they clicked for, but it is an answer.
const tree = () =>
  watchToken && PublicWatch ? (
    <ChunkLoadBoundary fallback={<App />}>
      <Suspense fallback={<div className="h-screen bg-slate-900" />}>
        <PublicWatch token={watchToken} />
      </Suspense>
    </ChunkLoadBoundary>
  ) : (
    <App />
  )

const render = () =>
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        {tree()}
      </ErrorBoundary>
    </StrictMode>,
  )

// Locale first so every surface — including the ErrorBoundary — has strings.
// English resolves synchronously (bundled); for a returning es/fr visitor we
// await their chunk before the first paint so they never see English flash to
// their language. A failed load falls back to English and still renders.
initI18n(detectInitialLocale()).finally(render)
