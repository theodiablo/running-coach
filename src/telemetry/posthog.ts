// PostHog adapter for the telemetry seam (./index.js). This is the ONLY file
// that imports the SDK, so the rest of the app stays vendor-neutral.
//
// posthog-js is pulled in by a dynamic import the first time telemetry actually
// activates, so it never weighs down the main bundle — or any build that ships
// without a key. Calls made before that import resolves are queued and replayed
// in order once it lands.

import { isNative } from "../native";

const KEY = import.meta.env.VITE_POSTHOG_KEY || "";
// Default to PostHog EU Cloud (privacy hosting, per the project's data-handling
// choice); override with VITE_POSTHOG_HOST for a different region/self-host.
const HOST = import.meta.env.VITE_POSTHOG_HOST || "https://eu.i.posthog.com";
// Tags every event so production / PR-preview / local traffic is filterable in
// PostHog. Set per build by the deploy workflows; "development" when unset
// (local). Vite's own MODE can't tell production from preview — both are a
// `vite build` — so this is an explicit var.
const ENV = import.meta.env.VITE_APP_ENV || "development";

type TelemetryProps = Record<string, unknown>;
type ConsentChoice = { analytics: boolean; crashes: boolean };
type PostHogLike = {
  init: (key: string, options: Record<string, unknown>) => void;
  register: (props: TelemetryProps) => void;
  set_config: (options: Record<string, unknown>) => void;
  opt_in_capturing: (options?: Record<string, unknown>) => void;
  opt_out_capturing: () => void;
  has_opted_out_capturing: () => boolean;
  identify: (id: string) => void;
  reset: () => void;
  capture: (event: string, props?: TelemetryProps) => void;
  captureException: (error: Error, context?: TelemetryProps) => void;
};

// Product-analytics consent, pushed by the seam. It decides the SDK's automatic
// web events, which must stay off for a crash-reports-only consent — including
// while captureError has the SDK opted in to send one exception.
let analyticsAllowed = false;
const webEvents = () => ({ capture_pageview: analyticsAllowed, capture_pageleave: analyticsAllowed });

let ph: PostHogLike | null = null; // resolved posthog instance, once loaded + init'd
let loading: Promise<void> | null = null; // in-flight dynamic import; null again if it fails (retryable)
const queue: ((posthog: PostHogLike) => void)[] = []; // calls deferred until the SDK is ready

function ensureLoaded() {
  if (ph || loading) return;
  loading = import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.init(KEY, {
        // Standard product-analytics web events (pageviews + pageleaves) give
        // visitor/session counts and populate PostHog's Web Analytics; both are
        // part of the core bundle (no remote fetch), so they work under our CSP,
        // on web AND inside the native WebView (one pageview per app open, since
        // there's no router). They follow the ANALYTICS channel — see webEvents.
        api_host: HOST,
        ...webEvents(),
        // Autocapture stays OFF *by design*: it records the visible text of
        // clicked elements ($el_text), which in this app can include race names
        // and run details — exactly the free text the telemetry policy never
        // sends (see docs/telemetry.md). Don't flip this without revisiting that.
        autocapture: false,
        // Automatic exception capture (capture_exceptions) stays OFF too: it
        // lazy-loads `exception-autocapture.js` from PostHog's asset host, which
        // disable_external_dependency_loading + our CSP (script-src 'self')
        // block — so it would silently never load. Crashes are captured with the
        // BUNDLED captureException API instead, driven from our own consent-gated
        // handlers (index.ts global handlers + ErrorBoundary).
        capture_exceptions: false,
        disable_session_recording: true,
        // Unused capture surfaces, off explicitly rather than by default: they
        // are product analytics, so they must not ride along on a crash-only
        // consent (or get switched on by PostHog's remote config).
        capture_heatmaps: false,
        capture_dead_clicks: false,
        capture_performance: false,
        // Don't fetch PostHog's optional remote scripts (recorder, surveys,
        // toolbar, …). We use none of them, and this keeps the CSP tight: only
        // connect-src needs *.i.posthog.com, script-src stays 'self'. Event
        // capture + manual captureException are bundled, so they're unaffected.
        disable_external_dependency_loading: true,
        person_profiles: "identified_only",
        opt_out_capturing_by_default: true,
      });
      // Super properties — merged into every event, including $exception, so
      // crashes carry the environment/platform too.
      posthog.register({ environment: ENV, native: isNative });
      const loaded = posthog as PostHogLike;
      ph = loaded;
      queue.forEach((fn) => fn(loaded));
      queue.length = 0;
    })
    .catch(() => { loading = null; }); // swallow load failures; never crash the app
}

// Run `fn` against the posthog instance now, or queue it until the SDK loads.
function withPH(fn: (posthog: PostHogLike) => void) {
  const current = ph;
  if (current) fn(current);
  else { ensureLoaded(); queue.push(fn); }
}

export const posthogProvider = {
  isConfigured: () => !!KEY,

  // The SDK is opted in whenever EITHER channel is granted (crash reports need
  // it too) and never loaded at all while both are off, so nothing is stored on
  // the device before a choice. Analytics granularity is not opt-in/out state
  // but config: set_config runs BEFORE opt_in_capturing so the deferred initial
  // $pageview isn't emitted for a crash-only consent. captureEventName:false
  // suppresses PostHog's own $opt_in event (an event the user didn't trigger).
  setConsent({ analytics, crashes }: ConsentChoice) {
    analyticsAllowed = analytics;
    if (!analytics && !crashes) {
      if (ph) ph.opt_out_capturing();
      return;
    }
    withPH((p) => {
      p.set_config(webEvents());
      p.opt_in_capturing({ captureEventName: false });
    });
  },

  identify(id: string) {
    withPH((p) => p.identify(id));
  },

  reset() {
    withPH((p) => p.reset());
  },

  track(event: string, props?: TelemetryProps) {
    // `environment` and `native` ride along as super properties (see register).
    withPH((p) => p.capture(event, props));
  },

  // Defensive: if this is ever reached while the SDK is opted out, opt in just
  // long enough to send this one exception; we deliberately do NOT re-opt-out
  // synchronously (that can drop the still-queued report). Safe because the
  // automatic web events follow analyticsAllowed, so an opted-in crash-only SDK
  // still emits nothing but the $exception.
  captureError(error: Error, context?: TelemetryProps) {
    withPH((p) => {
      if (p.has_opted_out_capturing()) {
        p.opt_in_capturing({ captureEventName: false });
      }
      p.captureException(error, context);
    });
  },
};
