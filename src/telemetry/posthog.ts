// PostHog adapter for the telemetry seam (./index.js): the ONLY file importing the SDK. posthog-js loads by dynamic
// import on first activation (not in the main bundle or keyless builds); earlier calls are queued and replayed in order.

import { isNative } from "../native";
import { scrubEvent } from "./scrub";

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

// Public-page audience measurement (docs/telemetry.md#cookieless-public-pages):
// nothing stored on the device, no identity, counted by PostHog's daily-salted
// server hash. Set before the SDK loads; a page load is one mode or the other.
let cookieless = false;
const modeConfig = () =>
  cookieless
    ? {
        cookieless_mode: "always" as const,
        persistence: "memory" as const,
        capture_pageview: true,
        capture_pageleave: true,
        advanced_disable_flags: true,
        disable_surveys: true,
      }
    : { ...webEvents(), opt_out_capturing_by_default: true };

let ph: PostHogLike | null = null; // resolved posthog instance, once loaded + init'd
let loading: Promise<void> | null = null; // in-flight dynamic import; null again if it fails (retryable)
const queue: ((posthog: PostHogLike) => void)[] = []; // calls deferred until the SDK is ready

function ensureLoaded() {
  if (ph || loading) return;
  loading = import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.init(KEY, {
        // Pageviews + pageleaves feed Web Analytics; core bundle (no remote fetch), so CSP-safe on web and native (one pageview
        // per app open, no router). They follow the ANALYTICS channel (webEvents), except on a cookieless public page (modeConfig).
        api_host: HOST,
        // Autocapture stays OFF *by design*: it records the visible text of
        // clicked elements ($el_text), which in this app can include race names
        // and run details — exactly the free text the telemetry policy never
        // sends (see docs/telemetry.md). Don't flip this without revisiting that.
        autocapture: false,
        // Automatic exception capture stays OFF: it lazy-loads exception-autocapture.js, which disable_external_dependency_loading
        // and CSP script-src 'self' block. Crashes use the BUNDLED captureException from our consent-gated handlers
        // (index.ts global handlers + ErrorBoundary).
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
        before_send: scrubEvent,
        ...modeConfig(),
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

  // The SDK is opted in when EITHER channel is granted and never loaded while both are off. set_config runs BEFORE
  // opt_in_capturing so a crash-only consent emits no deferred initial $pageview; captureEventName:false suppresses
  // PostHog's own $opt_in event.
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

  // Anonymous pageview/pageleave only, independent of the consent flags: this
  // mode stores nothing and identifies no one. Never call it from the app.
  startCookieless() {
    if (ph || loading) return;
    cookieless = true;
    ensureLoaded();
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

  // Defensive: if reached while opted out, opt in just long enough to send this exception; do NOT re-opt-out synchronously
  // (can drop the queued report). Safe since automatic web events follow analyticsAllowed.
  captureError(error: Error, context?: TelemetryProps) {
    withPH((p) => {
      if (p.has_opted_out_capturing()) {
        p.opt_in_capturing({ captureEventName: false });
      }
      p.captureException(error, context);
    });
  },
};
