import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Mail, Loader } from "lucide-react";
import { supabase, authRedirectTo } from "../../supabase";
import { INPUT_CLS } from "../../constants";
import type { User } from "@supabase/supabase-js";

// Change the account email: one confirmation link, sent to the new address only
// (double_confirm_changes is off), and the old address gets a notification once
// it lands. `user.new_email` is set server-side while that's outstanding, so the
// pending note survives an app restart without any local state.
//
// The link is opened in the NEW inbox, which is very often a different device —
// hence the re-read on mount: `user` comes from the cached session and would
// otherwise leave the note up forever on an account that already changed.
//
// Works for Google sign-in accounts too: the Google identity is matched by its
// provider `sub`, not the email, so signing in with Google keeps working.
export function EmailSection({ user, showToast }: { user: User; showToast?: (msg: string, type?: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [checking, setChecking] = useState(false);

  // refreshSession re-reads the user and emits an auth event, so the session App
  // holds updates and `user.new_email` here clears itself once the link is open.
  const recheck = async () => {
    setChecking(true);
    try { await supabase.auth.refreshSession(); } catch { /* offline — the note just stays */ }
    setChecking(false);
  };
  const rechecked = useRef(false);
  useEffect(() => {
    if (!user.new_email || rechecked.current) return;
    rechecked.current = true;
    void recheck();
  }, [user.new_email]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const next = email.trim();
    if (!next || next === user.email) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.updateUser(
      { email: next }, { emailRedirectTo: authRedirectTo() });
    setBusy(false);
    if (err) {
      // The default mailer allows a couple of emails an hour; that limit is by
      // far the likeliest failure here, so name it instead of showing the raw
      // "email rate limit exceeded".
      const rateLimited = err.status === 429 || /rate limit/i.test(err.message || "");
      setError(rateLimited ? t("settings.account.emailRateLimited") : (err.message || t("settings.account.emailError")));
      return;
    }
    setSent(true);
    setOpen(false);
    setEmail("");
    showToast?.(t("settings.account.emailSentToast"));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Mail size={16} className="text-orange-400 shrink-0"/>
          <div className="min-w-0">
            <p className="text-sm text-slate-200">{t("settings.account.emailLabel")}</p>
            <p className="text-xs text-slate-500 truncate">{user.email}</p>
          </div>
        </div>
        {/* The visible word alone ("Change") repeats on the password row below,
            so the accessible name spells out which one this is. */}
        <button type="button" onClick={() => { setOpen(o => !o); setError(null); setSent(false); }}
          aria-label={open ? t("settings.account.emailCancelAria") : t("settings.account.emailChangeAria")}
          className="text-xs text-slate-400 hover:text-slate-200 shrink-0">
          {open ? t("common.cancel") : t("settings.account.emailChange")}
        </button>
      </div>

      {user.new_email && (
        <div className="text-xs text-amber-400 bg-amber-500/10 rounded-xl px-3 py-2 space-y-1.5">
          <p>{t("settings.account.emailPending", { email: user.new_email })}</p>
          <button type="button" onClick={() => { void recheck(); }} disabled={checking}
            className="flex items-center gap-1.5 text-amber-300 hover:text-amber-200 disabled:opacity-50">
            {checking && <Loader size={12} className="animate-spin"/>}
            {t("settings.account.emailPendingCheck")}
          </button>
        </div>
      )}

      {sent && !user.new_email && (
        <p className="text-xs text-emerald-300 bg-emerald-500/10 rounded-xl px-3 py-2">{t("settings.account.emailSent")}</p>
      )}

      {open && (
        <form onSubmit={submit} className="space-y-2">
          <input type="email" required value={email} autoComplete="email"
            placeholder={t("settings.account.emailNew")} aria-label={t("settings.account.emailNew")}
            onChange={e => setEmail(e.target.value)} className={INPUT_CLS}/>
          {error && <p className="text-xs text-red-400 bg-red-500/10 rounded-xl px-3 py-2">{error}</p>}
          <button type="submit" disabled={busy}
            className="w-full py-2.5 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center justify-center gap-2 disabled:opacity-50">
            {busy && <Loader size={15} className="animate-spin"/>}
            {t("settings.account.emailSubmit")}
          </button>
          <p className="text-xs text-slate-500">{t("settings.account.emailConfirmNote")}</p>
        </form>
      )}
    </div>
  );
}
