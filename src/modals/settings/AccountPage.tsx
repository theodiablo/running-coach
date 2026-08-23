import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Upload, Trash2, Shield } from "lucide-react";
import { LANGS, setLocale, currentLang, isLangId, type LangId } from "../../i18n";
import { INPUT_CLS, PRIVACY_URL, DISCLAIMER_URL } from "../../constants";
import { getConsent, setConsent, getCrashConsent, setCrashConsent } from "../../telemetry";
import { ToggleSwitch } from "../../components/ToggleSwitch";
import { EmailSection } from "./EmailSection";
import { PasswordSection } from "./PasswordSection";
import type { User } from "@supabase/supabase-js";
import type { SettingsState } from "../../types";

// Account: who you are and how you get in, plus the admin actions that don't
// belong anywhere else. Destructive last, as ever.
type AccountPageProps = {
  settings: SettingsState;
  saveSettings: (settings: SettingsState) => void;
  user?: User;
  onBackup: () => void;
  onRestore: () => void;
  onDeleteAccount?: () => void;
  showToast?: (msg: string, type?: string) => void;
};

export function AccountPage({ settings, saveSettings, user, onBackup, onRestore, onDeleteAccount, showToast }: AccountPageProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(settings.name || "");
  // Language: synced preference, falling back to whatever the UI is showing
  // (device-detected) when unset. Picking persists to the blob AND the
  // per-device rc_lang key (inside setLocale) so pre-auth screens match.
  const lang: LangId = isLangId(settings.language) ? settings.language : currentLang();
  const pickLang = (id: LangId) => {
    if (id !== settings.language) saveSettings({...settings, language: id});
    void setLocale(id);
  };
  // Auto-save on blur/Enter — no Save button.
  const commitName = () => {
    const n = name.trim();
    if (n !== (settings.name || "")) saveSettings({...settings, name: n});
  };

  // Telemetry consent (opt-in), two independent channels. The source of truth is
  // the telemetry module's per-device localStorage flags, answered first on the
  // first-run consent screen; these toggles just let the user change their mind.
  // Local state mirrors them so the switches re-render on tap.
  const [analyticsOn, setAnalyticsOn] = useState(getConsent());
  const [crashOn, setCrashOn] = useState(getCrashConsent());
  const toggleAnalytics = () => {
    const next = !analyticsOn;
    setConsent(next);
    setAnalyticsOn(next);
    if (showToast) showToast(next ? t("settings.privacy.sharingOn") : t("settings.privacy.sharingOff"));
  };
  const toggleCrash = () => {
    const next = !crashOn;
    setCrashConsent(next);
    setCrashOn(next);
    if (showToast) showToast(next ? t("settings.privacy.crashOn") : t("settings.privacy.crashOff"));
  };

  return (
    <>
      {/* Identity */}
      <div className="bg-slate-800 rounded-2xl p-4 space-y-4">
        <div>
          <label className="text-xs text-slate-400 block mb-1.5">{t("settings.profile.name")}</label>
          <input type="text" maxLength={40} value={name} placeholder={t("settings.profile.name")}
            onChange={e => setName(e.target.value)} onBlur={commitName}
            onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} className={INPUT_CLS}/>
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1.5">{t("settings.language.label")}</label>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t("settings.language.label")}>
            {LANGS.map(l => (
              <button key={l.id} type="button" onClick={() => pickLang(l.id)}
                role="radio" aria-checked={lang === l.id}
                className={"py-2 rounded-xl text-sm font-semibold transition-colors " +
                  (lang === l.id ? "bg-orange-500 text-white" : "bg-slate-700 hover:bg-slate-600 text-slate-200")}>
                {l.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Sign-in credentials. Hidden entirely when the session hasn't reached us
          (defensive — App only renders the app with one). */}
      {user && (
        <div className="bg-slate-800 rounded-2xl p-4 space-y-3">
          <p className="text-sm font-semibold text-slate-200">{t("settings.account.signInTitle")}</p>
          <EmailSection user={user} showToast={showToast}/>
          <PasswordSection user={user} showToast={showToast}/>
        </div>
      )}

      {/* Privacy */}
      <div className="bg-slate-800 rounded-2xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Shield size={15} className="text-orange-400"/>
          <p className="text-sm font-semibold text-slate-200">{t("settings.privacy.title")}</p>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-slate-200">{t("settings.privacy.crashLabel")}</p>
            <p className="text-xs text-slate-400">{t("settings.privacy.crashDesc")}</p>
          </div>
          <ToggleSwitch on={crashOn} onToggle={toggleCrash} label={t("settings.privacy.crashLabel")}/>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-slate-200">{t("settings.privacy.shareLabel")}</p>
            <p className="text-xs text-slate-400">{t("settings.privacy.shareDesc")}</p>
          </div>
          <ToggleSwitch on={analyticsOn} onToggle={toggleAnalytics} label={t("settings.privacy.shareAria")}/>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer"
            className="text-orange-400 hover:text-orange-300">
            {t("settings.privacy.policyLink")}
          </a>
          <span className="text-slate-600">·</span>
          <a href={DISCLAIMER_URL} target="_blank" rel="noopener noreferrer"
            className="text-orange-400 hover:text-orange-300">
            {t("settings.privacy.disclaimerLink")}
          </a>
        </div>
      </div>

      {/* Backup & restore */}
      <div className="bg-slate-800 rounded-2xl p-4 space-y-3">
        <p className="text-sm font-semibold text-slate-200">{t("settings.backup.title")}</p>
        <p className="text-xs text-slate-400">{t("settings.backup.desc")}</p>
        <div className="grid grid-cols-2 gap-2">
          <button onClick={onBackup}
            className="py-2.5 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center justify-center gap-2 transition-colors">
            <Download size={15}/>{t("settings.backup.backupBtn")}
          </button>
          <button onClick={onRestore}
            className="py-2.5 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center justify-center gap-2 transition-colors">
            <Upload size={15}/>{t("settings.backup.restoreBtn")}
          </button>
        </div>
      </div>

      {/* Deletion */}
      {onDeleteAccount && (
        <div className="bg-slate-800 rounded-2xl p-4 space-y-2">
          {/* In-app account deletion must be reachable on every platform:
              the App Store REQUIRES it for apps with account creation, and
              Play's data-deletion policy is happiest with it too. The flow
              is a plain Supabase RPC — nothing web-only about it. */}
          <button onClick={onDeleteAccount}
            className="w-full py-2.5 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-red-400 flex items-center justify-center gap-2 transition-colors">
            <Trash2 size={15}/>{t("settings.deleteAccount.title")}
          </button>
        </div>
      )}
    </>
  );
}
