import { useEffect, useRef, useState, useCallback, lazy, Suspense } from "react";
import { Loader } from "lucide-react";
import { App as CapApp } from "@capacitor/app";
import type { PluginListenerHandle } from "@capacitor/core";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { isNative, isIos } from "./native";
import { POLAR_DEEP_LINK, stashPolarReturn } from "./polarPreinit";
import { versionStatus } from "./utils/version";
import { UpdateRequired, UpdateBanner } from "./components/UpdatePrompt";
import { initStore, clearStore } from "./db";
import { fetchPremiumUntil } from "./premium";
import { identifyUser, resetUser } from "./telemetry";
import { ConsentBanner } from "./components/ConsentBanner";
import { ChunkLoadBoundary } from "./components/ChunkLoadBoundary";
import RunningCoach from "./RunningCoach";
import LoginScreen from "./LoginScreen";

// Web-only marketing landing shown to signed-out visitors at the root path.
// VITE_NATIVE_BUILD is set only by the Android build (see .github/workflows/
// android.yml), so this ternary constant-folds to `null` there and Rollup drops
// the entire marketing chunk from the APK — the native shell ships zero
// marketing bytes and goes straight to LoginScreen. On the web build the flag is
// unset, leaving it a lazy chunk that logged-in users never fetch.
const MarketingGate = import.meta.env.VITE_NATIVE_BUILD
  ? null
  : lazy(() => import("./marketing/MarketingGate"));

// Defensive cap on the initial auth resolution. Supabase requests are already
// bounded by the fetch timeout in supabase.js, so getSession() should always
// settle well within this; it exists only so a never-resolving auth check can
// never leave the user staring at the splash spinner forever.
const AUTH_INIT_TIMEOUT_MS = 20000;

function Splash() {
  return (
    <div className="h-screen bg-slate-900 flex items-center justify-center">
      <Loader className="text-orange-400 animate-spin" size={32} />
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined); // undefined = still resolving
  const [storeReady, setStoreReady] = useState(false);
  // Premium entitlement (profiles.premium_until). Server truth, read for UI
  // only — every premium feature is enforced in its edge function. Free until
  // the fetch lands, and on any failure.
  //
  // Stored WITH the user id it was read for, so it's invalidated during render
  // (below) rather than reset from an effect: sign-out and a user switch both
  // stop matching, so one account's entitlement can never flash on another's
  // session while a fetch is in flight.
  const [premium, setPremium] = useState<{ uid: string; until: string | null } | null>(null);
  const [authError, setAuthError] = useState<string | null>(null); // native deep-link sign-in failure
  const [updateState, setUpdateState] = useState<"ok" | "update-available" | "must-update">("ok"); // version gate
  // Which user id the store is currently loaded for. Guards against reloading
  // (and clobbering the in-memory cache) on every auth event — Supabase fires
  // onAuthStateChange on token refresh, tab refocus, and repeat SIGNED_IN, each
  // time with a brand-new session object.
  const loadedUidRef = useRef<string | null>(null);

  // Track the auth session.
  useEffect(() => {
    let active = true;
    const settle = (s: Session | null) => {
      if (active) setSession(s);
    };

    supabase.auth
      .getSession()
      .then(({ data }) => settle(data.session))
      .catch((err) => {
        // A *rejected* getSession() would otherwise leave `session` stuck at
        // `undefined` (infinite <Splash/>). Log it and fall back to the login
        // screen so the user can retry rather than being stranded.
        console.error("Initial getSession() failed", err);
        settle(null);
      });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      settle(s);
    });

    // Belt-and-suspenders: if the auth state is somehow still unresolved after
    // the cap (requests are already bounded by the fetch timeout in
    // supabase.js), drop to the login screen instead of spinning forever.
    const timer = setTimeout(() => {
      setSession((curr) => {
        if (curr !== undefined) return curr;
        console.error("Auth init did not settle in time; showing login");
        return null;
      });
    }, AUTH_INIT_TIMEOUT_MS);

    return () => {
      active = false;
      clearTimeout(timer);
      sub.subscription.unsubscribe();
    };
  }, []);

  // Inside the Capacitor shell, OAuth / magic-link redirects come back as a deep
  // link (see authRedirectTo). Complete the PKCE exchange so the WebView signs in.
  // No-op on the web (handled by detectSessionInUrl). Plugin imported lazily so it
  // stays out of the web bundle.
  // Persists the last-processed URL across Strict Mode remounts so a PKCE code
  // is never exchanged twice (codes are single-use; a double call yields invalid_grant).
  const lastUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isNative) return;
    let mounted = true;
    let listenerHandle: PluginListenerHandle | null = null;

    // Surface an auth failure on the login screen (passed down as a prop). When
    // there's no session, LoginScreen is rendered as our child, so this re-render
    // reaches it for both the warm-return and cold-start cases.
    const reportAuthError = (text: string) => setAuthError(text);

    // The OAuth flow opens in an in-app browser (LoginScreen). Android's custom
    // tab dismisses itself when the deep link fires, but iOS's
    // SFSafariViewController stays on screen over the app — close it once the
    // callback lands. Browser.close() is unimplemented on Android; ignore.
    const closeAuthBrowser = async () => {
      try {
        const { Browser } = await import("@capacitor/browser");
        await Browser.close();
      } catch { /* Android (unimplemented) or already closed — ignore */ }
    };

    const processUrl = async (url: string) => {
      if (!url || url === lastUrlRef.current) return; // de-dupe appUrlOpen vs getLaunchUrl
      lastUrlRef.current = url;
      // Polar OAuth return, bounced from the web origin by polarPreinit. It
      // carries a ?code= that is NOT a Supabase auth code — route it before the
      // exchangeCodeForSession below can eat it (the native twin of
      // polarPreinit's web-side guard). Stash for completePolarAuth (which
      // CSRF-validates the state) and wake whoever is mounted: RunningCoach
      // listens for the event (warm return), and its boot path re-reads the
      // stash anyway (cold start, where this may run before it mounts).
      if (url.startsWith(POLAR_DEEP_LINK)) {
        closeAuthBrowser(); // iOS: the OAuth SFSafariViewController is still up
        try {
          const p = new URL(url).searchParams;
          const code = p.get("code"), state = p.get("state");
          // A denial carries no code — stay silent (same choice as the web flow)
          // but still close the browser sheet above.
          if (code && state) stashPolarReturn(code, state);
        } catch { /* malformed — ignore */ }
        window.dispatchEvent(new Event("rc-polar-return"));
        return;
      }
      let params;
      try { params = new URL(url).searchParams; } catch { return; }
      // Provider-side denial/error (e.g. user cancels Google consent) carries no
      // `code` — surface it instead of silently no-oping.
      const provErr = params.get("error_description") || params.get("error");
      if (provErr) { closeAuthBrowser(); reportAuthError(provErr); return; }
      const code = params.get("code");
      if (!code) return; // not an auth callback
      closeAuthBrowser();
      try {
        await supabase.auth.exchangeCodeForSession(code);
      } catch (err) {
        console.error("Deep-link auth exchange failed", err);
        reportAuthError(err instanceof Error ? err.message : "Sign-in failed. Please try again.");
      }
    };

    (async () => {
      // Independent bridge calls — run them concurrently. getLaunchUrl covers the
      // cold start where the OS killed the app while the OAuth tab was open: that
      // callback intent relaunches MainActivity as the launch URL, not appUrlOpen.
      const [handle, launch] = await Promise.all([
        CapApp.addListener("appUrlOpen", ({ url }) => processUrl(url)),
        CapApp.getLaunchUrl(),
      ]);
      if (!mounted) { handle?.remove?.(); return; }
      listenerHandle = handle;
      if (launch?.url) processUrl(launch.url);
    })();

    return () => { mounted = false; listenerHandle?.remove?.(); };
  }, []);

  // Native-only version gate: compare the installed app version against the
  // remote app_config row. A failed check (offline, etc.) is ignored so it can
  // never lock the user out. Web is always "latest" (continuously deployed).
  useEffect(() => {
    if (!isNative) return;
    let cancelled = false;
    (async () => {
      try {
        const info = await CapApp.getInfo();
        const { data } = await supabase
          .from("app_config")
          .select("min_supported_version, latest_version, min_supported_version_ios, latest_version_ios")
          .eq("id", 1)
          .maybeSingle();
        // Each platform reads its own column pair: the stores roll out
        // independently (and a partial release can leave one store behind), so a
        // single shared version would lie to one of them.
        const config = data && (isIos
          ? { min_supported_version: data.min_supported_version_ios, latest_version: data.latest_version_ios }
          : data);
        if (!cancelled && config) setUpdateState(versionStatus(info.version, config));
      } catch { /* never block the app on a failed version check */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Load (or clear) the per-user store when the *user* changes. Keyed on the
  // user id, not the session object, so token refresh / refocus events don't
  // re-run initStore and overwrite the in-memory cache with stale DB data.
  useEffect(() => {
    if (session === undefined) return;
    let cancelled = false;
    if (session) {
      if (loadedUidRef.current === session.user.id) return; // already loaded
      // Tie telemetry to the Supabase user id (no-op without consent/provider).
      identifyUser(session.user.id);
      setStoreReady(false);
      initStore(session.user.id).then(() => {
        if (!cancelled) {
          loadedUidRef.current = session.user.id;
          setStoreReady(true);
        }
      });
      // Entitlement rides alongside the store load but is deliberately NOT
      // awaited before storeReady: a slow or failed read must never hold up the
      // splash, it just means the UI starts on the free tier (fetchPremiumUntil
      // never rejects). Because this effect is keyed on the user id, it runs
      // once per sign-in — refreshPremium below covers the rest.
      const uid = session.user.id;
      fetchPremiumUntil(uid).then(v => { if (!cancelled) setPremium({ uid, until: v }); });
    } else {
      // Signed out: drop the in-memory store and forget which user it held.
      // No need to reset storeReady here — we render <LoginScreen/> whenever
      // there's no session, and the next sign-in resets it before reloading.
      loadedUidRef.current = null;
      resetUser();
      clearStore();
      // The entitlement needs no reset here: it carries the uid it was read
      // for, so it stops matching the moment the session goes.
    }
    return () => {
      cancelled = true;
    };
  }, [session]);

  // Re-read the entitlement on demand. The load above runs once per sign-in, so
  // without this a user who was offline at cold start (or who was granted
  // premium mid-session) would stay locked until the app restarted — days, in a
  // long-lived native WebView. Called when a premium teaser opens, which is
  // exactly when a stale "locked" state is about to be shown.
  // Returns the FRESH value as well as storing it, so a caller can decide what
  // to show from this read instead of from the state it had a moment ago (React
  // won't have re-rendered yet). Never rejects — null means free.
  const uid = session?.user.id;
  const refreshPremium = useCallback(async (): Promise<string | null> => {
    if (!uid) return null;
    const until = await fetchPremiumUntil(uid);
    setPremium({ uid, until });
    return until;
  }, [uid]);
  // Derived during render: only the entitlement read for THIS user counts.
  const premiumUntil = premium && premium.uid === uid ? premium.until : null;

  // Hard version gate blocks everything, even the login screen.
  if (updateState === "must-update") return <UpdateRequired />;
  if (session === undefined) return <Splash />;
  // First-run telemetry opt-in. Shown over both the login screen and the app so
  // a visitor sees it at first visit; self-gates to nothing once decided (or if
  // telemetry isn't configured). Telemetry collects nothing until accepted here.
  if (!session) {
    // Web visitors land on the marketing site (with an in-page login modal);
    // the native shell skips it and shows LoginScreen directly. `isNative`
    // covers the runtime split; `MarketingGate` is null in the native build so
    // the chunk is never even shipped.
    if (!isNative && MarketingGate) {
      return (
        <>
          {/* If the marketing chunk can't be fetched (a stale chunk after a
              mid-session redeploy, or a network drop) fall back to the plain,
              statically-imported LoginScreen rather than crashing the app —
              signing out must never throw into the error boundary. */}
          <ChunkLoadBoundary fallback={<LoginScreen authError={authError} onClearAuthError={() => setAuthError(null)} />}>
            <Suspense fallback={<Splash />}>
              <MarketingGate />
            </Suspense>
          </ChunkLoadBoundary>
          <ConsentBanner onConsentChange={() => {}} />
        </>
      );
    }
    return (
      <>
        <LoginScreen authError={authError} onClearAuthError={() => setAuthError(null)} />
        <ConsentBanner onConsentChange={() => {}} />
      </>
    );
  }
  if (!storeReady) return <Splash />;
  return (
    <>
      {updateState === "update-available" && <UpdateBanner />}
      <RunningCoach onSignOut={() => supabase.auth.signOut()}
        premiumUntil={premiumUntil} onRefreshPremium={refreshPremium} />
      <ConsentBanner onConsentChange={(ok) => { if (ok) identifyUser(session.user.id); }} />
    </>
  );
}
