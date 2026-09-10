import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, Loader } from "lucide-react";
import { BrandLogo } from "./components/BrandLogo";
import { supabase } from "./supabase";
import { authErrorMessage } from "./utils/authErrors";
import { passwordProblem } from "./utils/account";
import { parkAuthNotice } from "./utils/authNotice";
import { INPUT_CLS } from "./constants";

// The other end of a password-reset link. Reached only from App, which renders
// it over everything once a recovery callback lands (see CLAUDE.md "Auth
// callbacks") — the link itself has already signed the user in, so this is the
// one screen between them and the app.
//
// Its own screen rather than a branch of LoginScreen: nothing here is a login,
// and rather than a Settings sub-page because the store may still be loading
// (or failing) and setting a password must not wait on app_state.
export default function ResetPasswordScreen({ email, onDone }: { email?: string | null; onDone: () => void }) {
  const { t } = useTranslation();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
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
    if (err) {
      const mapped = authErrorMessage(err);
      setError(mapped ? t(mapped.key, mapped.vars) : err.message || t("login.newPassword.error"));
      return;
    }
    // Parked, not emitted: RunningCoach owns the only toast and mounts as this
    // screen goes away, so a live dispatch would have nowhere to land.
    parkAuthNotice("settings.account.passwordUpdated");
    onDone();
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-6">
          <BrandLogo className="text-orange-400" size={26} />
          <h1 className="text-xl font-bold text-white">{t("login.brand")}</h1>
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-5 shadow-xl">
          <div className="text-center space-y-3 mb-4">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-orange-500/15 flex items-center justify-center">
              <KeyRound className="text-orange-400" size={24} />
            </div>
            <h2 className="text-lg font-bold text-white">{t("login.newPassword.title")}</h2>
            {email && <p className="text-sm text-slate-400">{t("login.newPassword.signedInAs", { email })}</p>}
          </div>

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
              className="w-full flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-60 text-white font-medium py-2.5 rounded-lg transition">
              {busy && <Loader size={16} className="animate-spin"/>}
              {t("login.newPassword.save")}
            </button>
          </form>

          {/* The link already signed them in, so this screen must never be a
              trap — on the web there is no back button to escape it with. */}
          <button type="button" onClick={onDone}
            className="mt-3 w-full text-sm text-slate-400 hover:text-slate-200 underline">
            {t("login.newPassword.skip")}
          </button>
        </div>
      </div>
    </div>
  );
}
