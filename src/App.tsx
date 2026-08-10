import { useEffect, useRef, useState, useCallback, lazy, Suspense } from "react";
import { Loader } from "lucide-react";
import { App as CapApp } from "@capacitor/app";
import type { PluginListenerHandle } from "@capacitor/core";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { isNative, isIos } from "./native";
import { stashCloudReturn } from "./cloudOauthPreinit";
import { classifyAuthUrl, emailChangeOutcome } from "./utils/authCallback";
import { emitAuthNotice } from "./utils/authNotice";
import { versionStatus } from "./utils/version";
import { UpdateRequired, UpdateBanner } from "./components/UpdatePrompt";
import { initStore, clearStore, flushNow, subscribeStoreRefresh } from "./db";
import { readOfflineSession } from "./utils/offlineSession";
import { fetchPremiumUntil } from "./premium";
import { identifyUser, resetUser } from "./telemetry";
import { ConsentBanner } from "./components/ConsentBanner";
import { ChunkLoadBoundary } from "./components/ChunkLoadBoundary";
import { StoreLoadError } from "./components/StoreLoadError";
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

// Resolve an email-change confirmation against SERVER truth (the redirect can
// lie either way — see emailChangeOutcome) and report what actually landed. The
// re-read doubles as the refresh that clears the "waiting for confirmation"
// banner; without it the app renders the stale cached user and the tap looks
// like it did nothing. `pendingBefore` is user.new_email before the callback.
async function settleEmailChange(pendingBefore: string | null, opts: { user?: User | null; failure?: string } = {}) {
  let user = opts.user ?? null;
  if (!user) {
    try {
      const { data } = await supabase.auth.refreshSession();
      user = data.session?.user ?? null;
    } catch (err) {
      console.error("Could not re-read the account after an email-change link", err);
    }
  }
  const notice = emailChangeOutcome(pendingBefore, user, opts.failure);
  emitAuthNotice(notice.key, notice.type, notice.vars);
}

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
  // The user id whose app_state row could not be read, or null. Distinct from
  // "not ready yet": the store refuses to write until a load succeeds (db.ts),
  // so rendering the app here would show an empty account the user cannot save
  // out of. Offer a retry instead.
  //
  // Held WITH the user id (same pattern as `premium` above) so sign-out and a
  // user switch invalidate it during render rather than from an effect.
  // `storeAttempt` re-runs the load effect.
  const [storeFailedUid, setStoreFailedUid] = useState<string | null>(null);
  const [storeAttempt, setStoreAttempt] = useState(0);
  // Bumped when db.ts adopts a newer server row over an offline-booted cache:
  // the UI's copies are stale, so RunningCoach is remounted (keyed below) to
  // re-read the store.
  const [storeNonce, setStoreNonce] = useState(0);
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
  // Latest session, readable from the once-registered deep-link listener below.
  const sessionRef = useRef<Session | null>(null);

  // Session adopted from supabase-js's own storage because getSession() came
  // back empty on an unreachable network (offline cold start with an expired
  // access token — the session survives in storage but can't be refreshed).
  // Only a real auth event may replace it: a fresh session clears it, an
  // explicit SIGNED_OUT clears it, but the null that every failed offline
  // refresh emits must NOT bounce the user to the login screen.
  const offlineSessionRef = useRef<Session | null>(null);

  // Track the auth session.
  useEffect(() => {
    let active = true;
    const settle = (s: Session | null) => {
      if (active) setSession(s);
    };
    // No session from the server path: before falling to the login screen, see
    // if supabase-js still holds a recently-live session it merely failed to
    // refresh (offline). Signed-out storage is empty, so this can never
    // resurrect a session the user ended.
    const settleWithFallback = (s: Session | null) => {
      const adopted = s ?? readOfflineSession();
      if (!s && adopted) offlineSessionRef.current = adopted;
      settle(adopted);
    };

    supabase.auth
      .getSession()
      .then(({ data }) => settleWithFallback(data.session))
      .catch((err) => {
        // A *rejected* getSession() would otherwise leave `session` stuck at
        // `undefined` (infinite <Splash/>). Log it and fall back to the login
        // screen so the user can retry rather than being stranded.
        console.error("Initial getSession() failed", err);
        settleWithFallback(null);
      });

    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (s) {
        offlineSessionRef.current = null; // a real session supersedes the adopted one
      } else if (offlineSessionRef.current) {
        if (event !== "SIGNED_OUT") return; // offline refresh failure — keep the adopted session
        offlineSessionRef.current = null;
      }
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

  // Mirror of `session` for the long-lived deep-link listener below: it is
  // registered once, so a captured `session` would be stuck at its first value.
  // eslint-disable-next-line react-hooks/refs
  sessionRef.current = session ?? null;

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
      const cb = classifyAuthUrl(url);
      // Read BEFORE any await: an email-change callback updates the session
      // mid-flight, and settleEmailChange needs the pre-callback value to tell
      // "the change just completed" from "that link was never valid".
      const signedIn = !!sessionRef.current;
      const pendingBefore = sessionRef.current?.user?.new_email ?? null;
      switch (cb.kind) {
        // Cloud-provider OAuth return, bounced from the web origin by
        // cloudOauthPreinit. Its ?code= is NOT a Supabase auth code —
        // classifyAuthUrl routes it before the exchangeCodeForSession below can
        // eat it (the native twin of the preinit's web-side guard). Stash for
        // the provider's completeAuth (which CSRF-validates the state) and wake
        // whoever is mounted: RunningCoach listens for the event (warm return),
        // and its boot path re-reads the stash anyway (cold start, where this
        // may run before it mounts).
        case "cloudOauth":
          closeAuthBrowser(); // iOS: the OAuth SFSafariViewController is still up
          // A denial carries no code — stay silent (same choice as the web flow)
          // but still close the browser sheet above.
          if (cb.code && cb.state) stashCloudReturn(cb.provider, cb.code, cb.state);
          window.dispatchEvent(new CustomEvent("rc-cloud-oauth-return", { detail: { id: cb.provider } }));
          return;
        // Provider-side denial/error (e.g. user cancels Google consent) carries
        // no `code` — surface it instead of silently no-oping. Signed OUT that
        // means the login screen; signed IN it can only be an email-change link
        // (the app is on screen, and LoginScreen — the only thing that renders
        // reportAuthError — is not), and an expired/already-used link there does
        // NOT mean the change failed, so let the server have the last word.
        case "error":
          closeAuthBrowser();
          if (signedIn) await settleEmailChange(pendingBefore, { failure: cb.message });
          else reportAuthError(cb.message);
          return;
        // Email-change confirmation link (Settings -> Account) in its
        // ?token_hash=&type=email_change shape — sent when the mail template
        // uses {{ .TokenHash }}; these need verifyOtp, not the PKCE exchange.
        case "otp":
          closeAuthBrowser();
          try {
            await supabase.auth.verifyOtp({ token_hash: cb.tokenHash, type: cb.otpType });
          } catch (err) {
            console.error("Email confirmation failed", err);
          }
          if (signedIn) await settleEmailChange(pendingBefore);
          return;
        // GoTrue accepted the link but handed back nothing to exchange.
        // Nothing to do locally except re-read and say where the change stands.
        case "notice":
          closeAuthBrowser();
          if (signedIn) await settleEmailChange(pendingBefore);
          return;
        case "code":
          closeAuthBrowser();
          try {
            const { data } = await supabase.auth.exchangeCodeForSession(cb.code);
            // Signed in already: an email-change confirmation, not a sign-in.
            // The exchange handed us a fresh user, so skip the extra round trip.
            if (signedIn) await settleEmailChange(pendingBefore, { user: data.session?.user ?? null });
          } catch (err) {
            console.error("Deep-link auth exchange failed", err);
            // The exchange needs the PKCE verifier from the device that started
            // the flow, so a link opened elsewhere fails here even though the
            // change landed server-side. Never report that as a failure.
            if (signedIn) await settleEmailChange(pendingBefore, { failure: err instanceof Error ? err.message : "exchange failed" });
            else reportAuthError(err instanceof Error ? err.message : "Sign-in failed. Please try again.");
          }
          return;
        case "none":
          return;
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

  // Web twin of the handler above, for email-change links only. In the browser
  // the confirmation redirect lands back on our own origin: supabase-js consumes
  // a `?code=` itself (detectSessionInUrl), but the `?message=` (first of two)
  // and `?error=` (expired/used link) returns are ours to read — and without
  // this, opening the link on the web is the same silent no-op the native shell
  // had. Signed-in only: signed out, these are sign-in failures, not ours.
  const webCallbackRef = useRef(false);
  useEffect(() => {
    if (isNative || !session?.user || webCallbackRef.current) return;
    const cb = classifyAuthUrl(window.location.href);
    if (cb.kind !== "notice" && cb.kind !== "error") return;
    webCallbackRef.current = true;
    // Strip the params first so a reload (or the refreshSession below landing a
    // new session) can never replay the notice.
    const url = new URL(window.location.href);
    for (const k of ["message", "error", "error_code", "error_description"]) url.searchParams.delete(k);
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    const cleanHash = hash.has("error") || hash.has("message") ? "" : url.hash;
    window.history.replaceState({}, "", `${url.pathname}${url.search}${cleanHash}`);
    settleEmailChange(session.user.new_email ?? null, cb.kind === "error" ? { failure: cb.message } : {});
  }, [session]);

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
      initStore(session.user.id).then((result) => {
        if (cancelled) return;
        if (result === "failed") {
          // Leave loadedUidRef unset so a retry re-runs this effect rather than
          // short-circuiting on the "already loaded" guard.
          setStoreFailedUid(session.user.id);
          return;
        }
        // Offline boot: the app runs on the locally-mirrored data. Say so —
        // silence would make any staleness look like data loss.
        if (result === "offline") emitAuthNotice("app.offline.usingLocal");
        loadedUidRef.current = session.user.id;
        setStoreFailedUid(null);
        setStoreReady(true);
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
  }, [session, storeAttempt]);

  // After an offline boot, reconnecting may reveal a newer server row (another
  // device wrote while this one was offline). db.ts adopts it into the cache;
  // this remounts the app over it and says why the screen just refreshed.
  useEffect(() => subscribeStoreRefresh(() => {
    emitAuthNotice("app.offline.refreshed");
    setStoreNonce(n => n + 1);
  }), []);

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

  // Persist anything still in the debounce buffer BEFORE tearing the session
  // down. clearStore() drops the pending timer, and once signOut() lands the
  // JWT is gone and the write would fail RLS, so the last ~600ms of edits
  // (ticking a session, editing a run) would silently never reach the row.
  const signOutFlushed = useCallback(() => {
    flushNow().finally(() => { supabase.auth.signOut(); });
  }, []);

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
  // The load failed. Never fall through to the app: an empty store reads as a
  // brand-new account (onboarding), and writing from it would replace the row.
  if (storeFailedUid === session.user.id) {
    return (
      <StoreLoadError
        onRetry={() => { setStoreFailedUid(null); setStoreAttempt(n => n + 1); }}
        onSignOut={signOutFlushed}
      />
    );
  }
  if (!storeReady) return <Splash />;
  return (
    <>
      {updateState === "update-available" && <UpdateBanner />}
      <RunningCoach key={storeNonce} onSignOut={signOutFlushed} user={session.user}
        premiumUntil={premiumUntil} onRefreshPremium={refreshPremium} />
      <ConsentBanner onConsentChange={(ok) => { if (ok) identifyUser(session.user.id); }} />
    </>
  );
}
