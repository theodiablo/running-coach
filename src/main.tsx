import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// Sets window.__NATIVE_SHELL__ inside the Capacitor shell before the app renders
// (no-op in the browser). Imported first so the flag is ready for everything.
import './native'
// Captures a cloud provider's OAuth `?code=` return (Polar, …) and strips it
// BEFORE the Supabase client (imported via ./App below) can consume it as its
// own PKCE code. Must stay above ./App. No-op on every normal load. See
// src/cloudOauthPreinit.ts.
import './cloudOauthPreinit'
import { initI18n, detectInitialLocale } from './i18n'
import { initTelemetry, installGlobalErrorHandlers } from './telemetry'
import { ErrorBoundary } from './components/ErrorBoundary'
import App from './App'

// Start telemetry (no-op until a provider is wired in and the user consents)
// and catch foreground errors that escape React. Both honour the consent flag.
initTelemetry()
installGlobalErrorHandlers()

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

const render = () =>
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )

// Locale first so every surface — including the ErrorBoundary — has strings.
// English resolves synchronously (bundled); for a returning es/fr visitor we
// await their chunk before the first paint so they never see English flash to
// their language. A failed load falls back to English and still renders.
initI18n(detectInitialLocale()).finally(render)
