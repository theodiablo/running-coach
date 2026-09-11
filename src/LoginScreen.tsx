import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Loader, Mail, MailCheck, Lock } from "lucide-react";
import { BrandLogo } from "./components/BrandLogo";
import { Browser } from "@capacitor/browser";
import { supabase, authRedirectTo } from "./supabase";
import { authErrorMessage, isInvalidCredentials, isEmailTaken } from "./utils/authErrors";
import { passwordProblem } from "./utils/account";
import { isNative, isAndroid } from "./native";
import { PRIVACY_URL, PASSWORD_MIN_LENGTH } from "./constants";

// What the visitor came here to do. It picks the copy and which call the one
// submit button makes first — NOT a mode the user has to choose: there are no
// tabs, because "do you already have an account?" is the question people are
// worst at answering quickly and the screen can answer it for them by trying.
type LoginIntent = "signin" | "signup";
// "info" is amber: nothing failed and nothing succeeded — an email is already
// on its way, or a limiter wants a moment.
type LoginMessage = { type: "err" | "ok" | "info"; text: string };
const MSG_CLS: Record<LoginMessage["type"], string> = {
  err: "text-red-400",
  ok: "text-emerald-400",
  info: "text-amber-400",
};
// The two dead ends the one form can hit, each with both ways out offered
// inline. Cleared as soon as the email or password changes — a fork is about
// the exact pair that was just tried.
type Fork = "signin-failed" | "email-taken";
// An email is out. Which one decides the copy; both replace the form.
type Sent = { kind: "signup" | "reset"; email: string };

type LoginScreenProps = {
  authError?: string | null;
  onClearAuthError?: () => void;
  // Defaults to signing in; the marketing "Get started" CTAs pass "signup".
  intent?: LoginIntent;
  // A password-reset link that GoTrue refused (expired, or already used). Opens
  // on the reset form with the failure shown, so asking for a fresh link is the
  // next tap rather than a hunt.
  resetLinkFailed?: boolean;
};

// `authError` is a native deep-link sign-in failure surfaced by App.tsx (e.g. the
// user cancels Google consent); shown until the user takes another action.
export default function LoginScreen({ authError, onClearAuthError, intent = "signin", resetLinkFailed = false }: LoginScreenProps) {
  const { t } = useTranslation();
  const [askingReset, setAskingReset] = useState(resetLinkFailed);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<LoginMessage | null>(
    resetLinkFailed ? { type: "err", text: t("login.reset.linkFailed") } : null,
  );
  const [fork, setFork] = useState<Fork | null>(null);
  // The address an email was just sent to. While it's set the form is replaced:
  // leaving a live send button under a one-line note is what made one user
  // press it six more times and collect a 429 each time.
  const [sent, setSent] = useState<Sent | null>(null);

  // Reconciled during render, not in an effect: on the native shell this screen
  // is already mounted when the deep link is judged dead, so seeding the state
  // at mount would leave the failure invisible on the one platform that reaches
  // it that way.
  const [failedShown, setFailedShown] = useState(resetLinkFailed);
  if (resetLinkFailed !== failedShown) {
    setFailedShown(resetLinkFailed);
    if (resetLinkFailed) {
      setAskingReset(true);
      setSent(null);
      setFork(null);
      setMsg({ type: "err", text: t("login.reset.linkFailed") });
    }
  }

  const note = (type: LoginMessage["type"], text: string) => { onClearAuthError?.(); setMsg({ type, text }); };
  // Prefer copy the user can act on; keep the server's own message when nothing
  // maps, rather than trading a specific error for a vaguer one.
  const noteError = (err: unknown) => {
    const mapped = authErrorMessage(err);
    if (mapped) note(mapped.tone === "info" ? "info" : "err", t(mapped.key, mapped.vars));
    else note("err", err instanceof Error ? err.message : t("login.genericError"));
  };
  // Local form messages take precedence; otherwise fall back to a deep-link error.
  const shownMsg: LoginMessage | null = msg || (authError ? { type: "err", text: authError } : null);
  // A fork and a message are both about the exact pair that was just tried;
  // editing either field makes them stale, so they go together.
  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    setFork(null);
    setMsg(null);
    set(e.target.value);
  };

  async function withGoogle() {
    setBusy(true);
    setMsg(null);
    // In the shell, open the provider in the system browser ourselves and let the
    // deep link bring the result back (App.tsx completes the exchange). On the web
    // Supabase performs the redirect for us.
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: authRedirectTo(), skipBrowserRedirect: isNative },
    });
    if (error) {
      noteError(error);
      setBusy(false);
      return;
    }
    if (isNative && data?.url) {
      // Android must NOT go through @capacitor/browser: its Chrome Custom Tabs
      // path only catches ActivityNotFoundException natively, so any other
      // runtime failure launching the tab kills the process (the same crash that
      // took down the "Update" button — see openStore in UpdatePrompt.tsx). A
      // plain top-frame navigation is intercepted by Capacitor's WebViewClient
      // (Bridge.launchIntent): the external OAuth host never loads in the WebView,
      // it's handed to the OS as an ACTION_VIEW intent that opens in the default
      // browser, and Google redirects back to the deep link (App.tsx completes the
      // PKCE exchange). The WebView stays on localhost, so re-enabling the form
      // below is still correct.
      if (isAndroid) {
        window.location.assign(data.url);
        setBusy(false);
        return;
      }
      // iOS: SFSafariViewController is the correct pattern (no WebViewClient
      // intent interception there) and stays over the app until the deep link
      // lands, when App.tsx closes it.
      await Browser.open({ url: data.url });
      // The external tab handles the rest; the WebView itself is NOT redirected, so
      // re-enable the form. Otherwise dismissing/cancelling the OAuth tab (no
      // appUrlOpen, no auth event) would leave the UI locked until a restart. On
      // success, App.tsx's deep-link handler drives the transition to the app.
      setBusy(false);
      return;
    }
    // Web: the page itself is redirected to the provider, so leave busy=true.
  }

  async function signIn() {
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      // onAuthStateChange in App handles the transition
    } catch (err) {
      // Neither we nor the user can tell "no account" from "wrong password"
      // here — but the user knows which they meant, so offer both doors.
      if (isInvalidCredentials(err)) { onClearAuthError?.(); setMsg(null); setFork("signin-failed"); }
      else noteError(err);
    }
  }

  async function createAccount() {
    // The server is the authority, but it only gets asked once the password is
    // worth sending: sign-in has no such rule, so the one field can't enforce
    // it up front the way the old sign-up tab did.
    if (passwordProblem(password, password)) {
      note("err", t("settings.account.passwordRules"));
      return;
    }
    try {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: authRedirectTo() },
      });
      if (error) throw error;
      onClearAuthError?.();
      setMsg(null);
      setFork(null);
      setSent({ kind: "signup", email: email.trim() });
    } catch (err) {
      noteError(err);
      if (isEmailTaken(err)) setFork("email-taken");
    }
  }

  async function sendResetLink() {
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: authRedirectTo() });
      if (error) throw error;
      onClearAuthError?.();
      setMsg(null);
      setFork(null);
      setSent({ kind: "reset", email: email.trim() });
    } catch (err) {
      noteError(err);
    }
  }

  // One busy/clear wrapper for every action, so a form submit and a fork
  // button behave identically.
  const run = (action: () => Promise<void>) => async (e?: FormEvent | { preventDefault: () => void }) => {
    e?.preventDefault();
    setBusy(true);
    setMsg(null);
    await action();
    setBusy(false);
  };

  const onSubmit = run(intent === "signup" ? createAccount : signIn);
  const backToForm = () => { setSent(null); setAskingReset(false); setMsg(null); setFork(null); };

  const emailField = (
    <label className="block">
      <span className="text-xs text-slate-400">{t("login.email")}</span>
      <div className="mt-1 flex items-center gap-2 bg-slate-900 border border-slate-700 rounded-lg px-3">
        <Mail size={16} className="text-slate-500" />
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={edit(setEmail)}
          className="flex-1 bg-transparent py-2 text-sm text-white outline-none"
          placeholder={t("login.emailPlaceholder")}
        />
      </div>
    </label>
  );

  const message = shownMsg && (
    <p className={"mt-4 text-sm text-center " + MSG_CLS[shownMsg.type]}>{shownMsg.text}</p>
  );

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-6">
          <BrandLogo className="text-orange-400" size={26} />
          <h1 className="text-xl font-bold text-white">{t("login.brand")}</h1>
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-5 shadow-xl">
          {sent ? (
            /* An email is out. Show where it went and how to get out of here,
               with nothing left to press. */
            <div className="text-center space-y-3">
              <div className="mx-auto w-12 h-12 rounded-2xl bg-orange-500/15 flex items-center justify-center">
                <MailCheck className="text-orange-400" size={24} />
              </div>
              <h2 className="text-lg font-bold text-white">{t("login.sent.title")}</h2>
              <p className="text-sm text-slate-300">
                {/* Reset never claims an email was sent: Supabase answers a
                    reset request the same way for a known and an unknown
                    address, so "we sent it" would be a claim the server never
                    made — and a way to check who has an account here. */}
                {sent.kind === "reset"
                  ? t("login.reset.sentBody", { email: sent.email })
                  : t("login.sent.body", { email: sent.email })}
              </p>
              <p className="text-xs text-slate-500">{t("login.sent.spam")}</p>
              <button type="button" onClick={backToForm}
                className="text-sm text-slate-400 hover:text-slate-200 underline">
                {sent.kind === "reset" ? t("login.reset.back") : t("login.sent.back")}
              </button>
            </div>
          ) : askingReset ? (
            <>
              <div className="text-center space-y-1 mb-4">
                <h2 className="text-lg font-bold text-white">{t("login.reset.title")}</h2>
                <p className="text-sm text-slate-400">{t("login.reset.intro")}</p>
              </div>
              <form onSubmit={run(sendResetLink)} className="space-y-3">
                {emailField}
                <button type="submit" disabled={busy}
                  className="w-full flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-60 text-white font-medium py-2.5 rounded-lg transition">
                  {busy && <Loader size={16} className="animate-spin" />}
                  {t("login.reset.send")}
                </button>
              </form>
              <button type="button" onClick={backToForm}
                className="mt-3 w-full text-sm text-slate-400 hover:text-slate-200 underline">
                {t("login.reset.back")}
              </button>
              {message}
            </>
          ) : (
            <>
              <h2 className="text-lg font-bold text-white text-center mb-4">
                {intent === "signup" ? t("login.headingSignup") : t("login.heading")}
              </h2>

              {/* Google first: the one way in with no password to forget. */}
              <button
                type="button"
                onClick={withGoogle}
                disabled={busy}
                className="w-full flex items-center justify-center gap-2 bg-white hover:bg-slate-100 disabled:opacity-60 text-slate-800 font-medium py-2.5 rounded-lg transition"
              >
                <GoogleIcon />
                {t("login.continueWithGoogle")}
              </button>

              <div className="flex items-center gap-3 my-4">
                <div className="h-px flex-1 bg-slate-700" />
                <span className="text-xs text-slate-500">{t("login.orWithEmail")}</span>
                <div className="h-px flex-1 bg-slate-700" />
              </div>

              <form onSubmit={onSubmit} className="space-y-3">
                {emailField}

                <label className="block">
                  <span className="text-xs text-slate-400">{t("login.password")}</span>
                  <div className="mt-1 flex items-center gap-2 bg-slate-900 border border-slate-700 rounded-lg px-3">
                    <Lock size={16} className="text-slate-500" />
                    <input
                      type="password"
                      required
                      // Sign-in must still accept accounts made under the old
                      // rule; the stronger policy is checked in createAccount,
                      // which is the only path that can create one.
                      minLength={intent === "signup" ? PASSWORD_MIN_LENGTH : 6}
                      autoComplete={intent === "signup" ? "new-password" : "current-password"}
                      value={password}
                      onChange={edit(setPassword)}
                      className="flex-1 bg-transparent py-2 text-sm text-white outline-none"
                      placeholder={t("login.passwordPlaceholder")}
                    />
                  </div>
                </label>

                {intent === "signup" && (
                  <p className="text-xs text-slate-500">{t("settings.account.passwordRules")}</p>
                )}

                <button
                  type="submit"
                  disabled={busy}
                  className="w-full flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-60 text-white font-medium py-2.5 rounded-lg transition"
                >
                  {busy && <Loader size={16} className="animate-spin" />}
                  {intent === "signup" ? t("login.createAccount") : t("login.continue")}
                </button>
              </form>

              {fork ? (
                <div className="mt-4 border border-slate-600 rounded-xl p-3 space-y-2.5 bg-slate-900/50">
                  <p className="text-sm text-slate-300">
                    {fork === "email-taken" ? t("login.fork.takenTitle") : t("login.fork.signInFailedTitle")}
                  </p>
                  {fork === "signin-failed" ? (
                    <>
                      <button type="button" disabled={busy} onClick={run(createAccount)}
                        className="w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-60 text-white text-sm font-medium py-2.5 rounded-lg transition">
                        {t("login.fork.create")}
                      </button>
                      <p className="text-xs text-slate-500">{t("settings.account.passwordRules")}</p>
                    </>
                  ) : (
                    <button type="button" disabled={busy} onClick={run(signIn)}
                      className="w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-60 text-white text-sm font-medium py-2.5 rounded-lg transition">
                      {t("login.fork.signIn")}
                    </button>
                  )}
                  <button type="button" disabled={busy} onClick={run(sendResetLink)}
                    className="w-full bg-slate-700 hover:bg-slate-600 disabled:opacity-60 text-slate-200 text-sm font-medium py-2.5 rounded-lg transition">
                    {t("login.fork.reset")}
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => { setAskingReset(true); setMsg(null); onClearAuthError?.(); }}
                  className="mt-3 w-full text-sm text-slate-400 hover:text-slate-200 underline">
                  {t("login.forgot")}
                </button>
              )}

              {message}
            </>
          )}
        </div>

        <p className="text-center text-xs text-slate-600 mt-4">
          {t("login.dataSync")}{" "}
          <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer"
            className="text-slate-500 underline hover:text-slate-300">{t("login.privacy")}</a>
        </p>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
      <path fill="#4CAF50" d="M24 44c5.5 0 10.5-2.1 14.3-5.6l-6.6-5.6c-2.1 1.5-4.8 2.4-7.7 2.4-5.2 0-9.6-3.3-11.2-8l-6.6 5.1C9.6 39.6 16.2 44 24 44z"/>
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.6 5.6C40.9 36.4 44 30.7 44 24c0-1.3-.1-2.3-.4-3.5z"/>
    </svg>
  );
}
