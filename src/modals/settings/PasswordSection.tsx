import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, Loader } from "lucide-react";
import { supabase } from "../../supabase";
import { INPUT_CLS } from "../../constants";
import { passwordProblem, hasEmailIdentity } from "../../utils/account";
import type { User } from "@supabase/supabase-js";

export function PasswordSection({ user, showToast }: { user: User; showToast?: (msg: string, type?: string) => void }) {
  const { t } = useTranslation();
  const hasPassword = hasEmailIdentity(user);
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(pw, confirm);
    if (problem) {
      setError(t(problem === "mismatch" ? "settings.account.passwordMismatch" : "settings.account.passwordRules"));
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (err) { setError(err.message || t("settings.account.passwordError")); return; }
    setOpen(false);
    setPw("");
    setConfirm("");
    showToast?.(t("settings.account.passwordUpdated"));
  };

  return (
    <div className="space-y-2 pt-3 border-t border-slate-700/60">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <KeyRound size={16} className="text-orange-400 shrink-0"/>
          <div className="min-w-0">
            <p className="text-sm text-slate-200">{t("settings.account.passwordLabel")}</p>
            {!hasPassword && <p className="text-xs text-slate-500">{t("settings.account.passwordSetDesc")}</p>}
          </div>
        </div>
        {/* See the matching note in EmailSection: "Change" appears twice on
            this page, so the accessible name says which. */}
        <button type="button" onClick={() => { setOpen(o => !o); setError(null); }}
          aria-label={open ? t("settings.account.passwordCancelAria") : (hasPassword ? t("settings.account.passwordChangeAria") : t("settings.account.passwordSet"))}
          className="text-xs text-slate-400 hover:text-slate-200 shrink-0">
          {open ? t("common.cancel") : (hasPassword ? t("settings.account.passwordChange") : t("settings.account.passwordSet"))}
        </button>
      </div>

      {open && (
        <form onSubmit={submit} className="space-y-2">
          <input type="password" required value={pw} autoComplete="new-password"
            placeholder={t("settings.account.passwordNew")} aria-label={t("settings.account.passwordNew")}
            onChange={e => setPw(e.target.value)} className={INPUT_CLS}/>
          <input type="password" required value={confirm} autoComplete="new-password"
            placeholder={t("settings.account.passwordConfirm")} aria-label={t("settings.account.passwordConfirm")}
            onChange={e => setConfirm(e.target.value)} className={INPUT_CLS}/>
          {/* The rules double as the error for a weak password, so show them
              once: as quiet helper text, or as the error pill. */}
          {error
            ? <p className="text-xs text-red-400 bg-red-500/10 rounded-xl px-3 py-2">{error}</p>
            : <p className="text-xs text-slate-500">{t("settings.account.passwordRules")}</p>}
          <button type="submit" disabled={busy}
            className="w-full py-2.5 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center justify-center gap-2 disabled:opacity-50">
            {busy && <Loader size={15} className="animate-spin"/>}
            {hasPassword ? t("settings.account.passwordChange") : t("settings.account.passwordSet")}
          </button>
        </form>
      )}
    </div>
  );
}
