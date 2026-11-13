import { useEffect, useRef, useState, useCallback, lazy, Suspense } from "react";
import { Loader } from "lucide-react";
import { App as CapApp } from "@capacitor/app";
import type { PluginListenerHandle } from "@capacitor/core";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { rememberAppleGrant } from "./auth/appleSignIn";
import { isNative, isIos } from "./native";
import { stashCloudReturn } from "./cloudOauthPreinit";
import { classifyAuthUrl, emailChangeOutcome, type RecoveryTokens } from "./utils/authCallback";
import { emitAuthNotice } from "./utils/authNotice";
import { versionStatus } from "./utils/version";
import { UpdateRequired } from "./components/UpdatePrompt";
import { initStore, clearStore, flushNow, subscribeStoreRefresh, clearOfflineMirror } from "./db";
import { clearShareLinkCache } from "./live/shareLinkStore";
import { readOfflineSession } from "./utils/offlineSession";
import { parkAuthNotice } from "./utils/authNotice";
import { readRecoveryBuffer } from "./utils/runRecovery";
import { INDOOR_RUN_KEY } from "./constants";
import { fetchPremiumUntil } from "./premium";
import { identifyUser, resetUser } from "./telemetry";
import { ConsentBanner } from "./components/ConsentBanner";
import { ChunkLoadBoundary } from "./components/ChunkLoadBoundary";
import { StoreLoadError } from "./components/StoreLoadError";
import RunningCoach from "./RunningCoach";
import LoginScreen from "./LoginScreen";
import ResetPasswordScreen from "./ResetPasswordScreen";

// Web-only marketing landing for signed-out visitors. VITE_NATIVE_BUILD (Android
// only) constant-folds this ternary to `null`, so Rollup drops the marketing
// chunk from the APK; on web it is a lazy chunk logged-in users never fetch.
const MarketingGate = import.meta.env.VITE_NATIVE_BUILD
  ? null
  : lazy(() => import("./marketing/MarketingGate"));

// Captured at module load, before supabase-js's own initialize() can strip its
// params from the URL: a mount effect reading window.location can miss them.
const initialUrl = typeof window !== "undefined" ? window.location.href : "";

// How long a recovery callback may take to produce a session before we call the
// link dead. Only reachable when supabase-js owns the exchange (a stock-template
// ?code=) and it fails silently — without this the user waits on the splash.
const RECOVERY_SETTLE_MS = 8000;

// Redeem a password-reset callback into a session for the account the link was
// sent to: token_hash (verifyOtp), ?code=, or an implicit-fragment session. A link
// yielding none must fail: the device may hold ANOTHER account and the
// new-password screen would set its password. Resolves to that account's id, or null if rejected.
async function redeemRecovery(cb: { tokenHash: string | null; code: string | null; tokens: RecoveryTokens | null }, exchangeCode: boolean): Promise<string | null> {
  try {
    let uid: string | undefined;
    if (cb.tokenHash) {
      const { data, error } = await supabase.auth.verifyOtp({ token_hash: cb.tokenHash, type: "recovery" });
      if (error) throw error;
      uid = data.user?.id;
    } else if (cb.tokens) {
      const { data, error } = await supabase.auth.setSession({ access_token: cb.tokens.accessToken, refresh_token: cb.tokens.refreshToken });
      if (error) throw error;
      uid = data.user?.id;
    } else if (cb.code && exchangeCode) {
      const { data, error } = await supabase.auth.exchangeCodeForSession(cb.code);
      if (error) throw error;
      uid = data.user?.id;
    } else if (cb.code) {
      const { error } = await supabase.auth.initialize(); // settles supabase-js's own exchange
      if (error) throw error;
      uid = (await supabase.auth.getSession()).data.session?.user.id;
    }
    return uid ?? null;
  } catch (err) {
    console.error("Password-reset link rejected", err);
    return null;
  }
}

// Defensive cap on the initial auth resolution. Supabase requests are already
// bounded by the fetch timeout in supabase.js, so getSession() should always
// settle well within this; it exists only so a never-resolving auth check can
// never leave the user staring at the splash spinner forever.
const AUTH_INIT_TIMEOUT_MS = 20000;

// An expired token holds getSession() on its refresh, which auth-js retries for ~30s on a weak
// network (a race start line). Past this, a recently-live stored session opens the app instead
// (same rule as the offline fallback) and the refresh carries on behind it.
const AUTH_FAST_BOOT_MS = 2500;

// Resolve an email-change confirmation against SERVER truth (the redirect can
// lie either way, see emailChangeOutcome). The re-read also refreshes the
// "waiting for confirmation" banner. `pendingBefore` is user.new_email before the callback.
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
  // "not ready": the store refuses writes until a load succeeds (db.ts), so offer
  // a retry instead of an empty account. Held WITH the user id (like `premium`) so
  // sign-out/user switch invalidate it during render; `storeAttempt` re-runs the load.
  const [storeFailedUid, setStoreFailedUid] = useState<string | null>(null);
  const [storeAttempt, setStoreAttempt] = useState(0);
  // Bumped when db.ts adopts a newer server row over an offline-booted cache:
  // the UI's copies are stale, so RunningCoach is remounted (keyed below) to
  // re-read the store.
  const [storeNonce, setStoreNonce] = useState(0);
  // Premium entitlement (profiles.premium_until): server truth, read for UI only;
  // enforced in each edge function. Free until the fetch lands and on any failure.
  // Stored WITH its user id so sign-out / user switch invalidate it during render,
  // never flashing one account's entitlement on another's session.
  const [premium, setPremium] = useState<{ uid: string; until: string | null } | null>(null);
  const [authError, setAuthError] = useState<string | null>(null); // native deep-link sign-in failure
  // A password-reset link is being redeemed: the new-password screen owns the app.
  // Set from our own classified callback AND supabase-js's PASSWORD_RECOVERY
  // event (which fires depends on the link shape). Holds the id of the account the
  // link was for; the screen sets only that account's password.
  const [recovering, setRecovering] = useState<string | null>(null);
  const [resetLinkFailed, setResetLinkFailed] = useState(false); // expired/used reset link
  const [updateState, setUpdateState] = useState<"ok" | "update-available" | "must-update">("ok"); // version gate
  const [latestVersion, setLatestVersion] = useState<string | null>(null); // shown on the Home update card
  // Which user id the store is currently loaded for. Guards against reloading
  // (and clobbering the in-memory cache) on every auth event — Supabase fires
  // onAuthStateChange on token refresh, tab refocus, and repeat SIGNED_IN, each
  // time with a brand-new session object.
  const loadedUidRef = useRef<string | null>(null);
  // Latest session, readable from the once-registered deep-link listener below.
  const sessionRef = useRef<Session | null>(null);

  // Session adopted from supabase-js storage when getSession() came back empty
  // offline (expired token, unrefreshable). Only a real auth event may replace it:
  // a fresh session or explicit SIGNED_OUT clears it, but the null every failed
  // offline refresh emits must NOT bounce the user to login.
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
      if (event === "PASSWORD_RECOVERY" && s) setRecovering(s.user.id);
      if (event === "SIGNED_IN" || event === "INITIAL_SESSION") rememberAppleGrant(s);
      if (s) {
        offlineSessionRef.current = null; // a real session supersedes the adopted one
      } else if (event === "SIGNED_OUT") {
        offlineSessionRef.current = null;
        setRecovering(null); // nothing to set a password on any more
        // The one place account data may leave the device: an explicit sign-out (or dead
        // refresh token). NOT in clearStore, which runs on transient null-session states
        // where wiping the mirror would destroy the offline boot. The cached share link
        // goes too: the next runner on this device must never see the last one's.
        clearOfflineMirror();
        clearShareLinkCache();
      } else if (offlineSessionRef.current) {
        return; // offline refresh failure — keep the adopted session
      }
      settle(s);
    });

    // Still resolving: adopt the stored session if it qualifies, else keep waiting (or, from
    // the safety net, drop to login). Must make the same offline fallback as the resolved
    // path, or a merely-offline user gets the login screen and a torn-down store.
    const adoptStored = (orLogin: boolean) => setSession((curr) => {
      if (curr !== undefined) return curr;
      const cached = readOfflineSession();
      if (cached) {
        offlineSessionRef.current = cached;
        return cached;
      }
      if (!orLogin) return curr;
      console.error("Auth init did not settle in time; showing login");
      return null;
    });
    // Not while a web auth callback is being redeemed: the session it yields is the one to use.
    const fastTimer = classifyAuthUrl(initialUrl).kind === "none"
      ? setTimeout(() => adoptStored(false), AUTH_FAST_BOOT_MS)
      : undefined;
    // Safety net: never spin forever.
    const timer = setTimeout(() => adoptStored(true), AUTH_INIT_TIMEOUT_MS);

    return () => {
      active = false;
      clearTimeout(fastTimer);
      clearTimeout(timer);
      sub.subscription.unsubscribe();
    };
  }, []);

  // In the Capacitor shell OAuth / magic-link redirects return as a deep link
  // (see authRedirectTo); complete the PKCE exchange. No-op on web; plugin is lazy.
  // The last-processed URL persists across Strict Mode remounts: PKCE codes are
  // single-use (a double call yields invalid_grant).
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
        // Cloud-provider OAuth return, bounced from the web origin by cloudOauthPreinit.
        // Its ?code= is NOT a Supabase code: classifyAuthUrl routes it before the
        // exchange. Stash it for the provider's completeAuth and wake RunningCoach (its
        // boot path re-reads the stash for cold starts).
        case "cloudOauth":
          closeAuthBrowser(); // iOS: the OAuth SFSafariViewController is still up
          // A denial carries no code — stay silent (same choice as the web flow)
          // but still close the browser sheet above.
          if (cb.code && cb.state) stashCloudReturn(cb.provider, cb.code, cb.state);
          window.dispatchEvent(new CustomEvent("rc-cloud-oauth-return", { detail: { id: cb.provider } }));
          return;
        // A provider-side denial carries no `code`; surface it. Signed OUT that means
        // the login screen; signed IN it can only be an email-change link, and an
        // expired/used link does NOT mean the change failed, so let the server have the last word.
        case "error":
          closeAuthBrowser();
          if (signedIn) await settleEmailChange(pendingBefore, { failure: cb.message });
          else reportAuthError(cb.message);
          return;
        // Password-reset link. Ahead of "code" in classifyAuthUrl for a
        // reason: exchanged as an ordinary sign-in it would drop the user into
        // the app with no way to set the password they came here to replace.
        case "recovery": {
          closeAuthBrowser();
          const recoveredUid = await redeemRecovery(cb, true);
          if (recoveredUid) setRecovering(recoveredUid);
          else if (signedIn) emitAuthNotice("app.toasts.resetLinkFailed", "err");
          else setResetLinkFailed(true);
          return;
        }
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

  // Web twin of the recovery branch above. Runs signed out too — opening a
  // reset link is how a user with no usable password gets back in.
  const recoveryUrlRef = useRef(false);
  useEffect(() => {
    if (isNative || recoveryUrlRef.current) return;
    const cb = classifyAuthUrl(initialUrl);
    if (cb.kind !== "recovery") return;
    recoveryUrlRef.current = true;
    // Only ours to clean up: a ?code= belongs to supabase-js, which reads it
    // asynchronously and strips it once spent. Stripping it here would race
    // that read and leave the link unredeemed.
    if (cb.tokenHash || cb.tokens) {
      const url = new URL(window.location.href);
      for (const k of ["token_hash", "type"]) url.searchParams.delete(k);
      const hash = cb.tokens ? "" : url.hash; // a live session must not linger in the URL
      window.history.replaceState({}, "", `${url.pathname}${url.search}${hash}`);
    }
    redeemRecovery(cb, false).then(uid => { if (uid) setRecovering(uid); else setResetLinkFailed(true); });
  }, []);

  // A reset link whose account never becomes the session must not strand the
  // user on the splash below. Signed in to another account, the login screen's
  // notice would never render, so that failure is a toast.
  const sessionUid = session?.user.id;
  useEffect(() => {
    if (!recovering || sessionUid === recovering) return;
    const timer = setTimeout(() => {
      setRecovering(null);
      if (sessionUid) emitAuthNotice("app.toasts.resetLinkFailed", "err");
      else setResetLinkFailed(true);
    }, RECOVERY_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [recovering, sessionUid]);

  // Web twin of the handler above, for email-change links only: `?message=` and
  // `?error=` returns land on our origin and are ours to read (supabase-js
  // consumes `?code=` itself). Signed-in only; signed out they are sign-in failures.
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
        const { data, error: configErr } = await supabase
          .from("app_config")
          .select("min_supported_version, latest_version, min_supported_version_ios, latest_version_ios")
          .eq("id", 1)
          .maybeSingle();
        if (configErr) console.error("Could not read app_config", configErr);
        // Each platform reads its own column pair: the stores roll out
        // independently (and a partial release can leave one store behind), so a
        // single shared version would lie to one of them.
        const config = data && (isIos
          ? { min_supported_version: data.min_supported_version_ios, latest_version: data.latest_version_ios }
          : data);
        if (!cancelled && config) {
          setUpdateState(versionStatus(info.version, config));
          setLatestVersion(config.latest_version ?? null);
        }
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
        if (result === "slow") emitAuthNotice("app.offline.slowLink");
        loadedUidRef.current = session.user.id;
        setStoreFailedUid(null);
        setStoreReady(true);
      });
      // Entitlement is deliberately NOT awaited before storeReady: a slow or failed
      // read must never hold the splash (fetchPremiumUntil never rejects). Runs once
      // per sign-in; refreshPremium covers the rest.
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

  // After an offline boot, a newer server row may appear on reconnect; db.ts adopts
  // it and this remounts the app over it with a notice. Parked, not emitted: a live
  // dispatch would be drained by the OUTGOING RunningCoach and die in its unmount.
  useEffect(() => subscribeStoreRefresh(() => {
    // Never tear down a live recording or unresumed interrupted-run offer; skipping
    // the remount only leaves views stale until next boot. BOTH recorders count:
    // indoor keeps its buffer under its own key (docs/indoor-sessions.md).
    if (readRecoveryBuffer() || readRecoveryBuffer(INDOOR_RUN_KEY, { requirePoints: false })) return;
    parkAuthNotice("app.offline.refreshed");
    setStoreNonce(n => n + 1);
  }), []);

  // Re-read the entitlement on demand (the load runs once per sign-in, so a stale
  // "locked" state would persist); called when a premium teaser opens.
  // Returns the FRESH value as well as storing it, since React hasn't re-rendered
  // yet. Never rejects; null means free.
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
  // A password-reset link landed. The new-password screen comes before the
  // store (it doesn't need app_state, and must not wait on a load that may be
  // failing) and before the login screen (the link already signed them in —
  // while the session is still landing, this is the splash).
  if (recovering) {
    return session?.user.id === recovering
      ? <ResetPasswordScreen email={session.user.email} onDone={() => setRecovering(null)} />
      : <Splash />;
  }
  // First-run telemetry opt-in. Shown over both the login screen and the app so
  // a visitor sees it at first visit; self-gates to nothing once decided (or if
  // telemetry isn't configured). Telemetry collects nothing until accepted here.
  if (!session) {
    // Web visitors get the marketing site (login in a modal); native shows LoginScreen directly.
    // A dead reset link skips marketing: its login modal is closed, hiding the
    // form that asks for a fresh link.
    if (!isNative && MarketingGate && !resetLinkFailed) {
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
        <LoginScreen authError={authError} onClearAuthError={() => setAuthError(null)} resetLinkFailed={resetLinkFailed} />
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
      <RunningCoach key={storeNonce} onSignOut={signOutFlushed} user={session.user}
        premiumUntil={premiumUntil} onRefreshPremium={refreshPremium}
        availableUpdate={updateState === "update-available" ? latestVersion : null} />
      <ConsentBanner onConsentChange={(ok) => { if (ok) identifyUser(session.user.id); }} />
    </>
  );
}
