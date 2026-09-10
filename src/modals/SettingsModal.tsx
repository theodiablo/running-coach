import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LogOut, MessageSquare } from "lucide-react";
import { useDismissable } from "../hooks/useDismissable";
import { SettingsHub } from "./settings/SettingsHub";
import { SubPage } from "./settings/SubPage";
import { AccountPage } from "./settings/AccountPage";
import { IntegrationsPage } from "./settings/IntegrationsPage";
import { TrainingProfilePage } from "./settings/TrainingProfilePage";
import type { User } from "@supabase/supabase-js";
import type { Plan, SettingsPage, SettingsState, UserContextState } from "../types";

type SettingsModalProps = {
  settings: SettingsState;
  saveSettings: (settings: SettingsState) => void;
  userContext: UserContextState;
  saveUserContext: (context: UserContextState) => void;
  user?: User;
  onBackup: () => void;
  onRestore: () => void;
  onSignOut?: () => void;
  onDeleteAccount?: () => void;
  onOpenCoach?: () => void;
  onImportFile?: () => void;
  onClose: () => void;
  /** Opens the beta feedback sheet. Settings is where people look for
   *  "how do I contact them", so it is the one door discoverable without
   *  ever having noticed the floating pill. */
  onFeedback: () => void;
  showToast?: (msg: string, type?: string) => void;
  scanImportsNow?: () => Promise<number>;
  plan?: Plan | null;
  // Open straight onto a sub-page. Every nudge that sends the user here is
  // about one specific setting (the tracker's HR prompt means Integrations,
  // the plan builder's means Training profile), and the hub menu is a dead end
  // for someone who was told to "set up" something in particular.
  initialPage?: SettingsPage;
};

// Settings is a hub, not a page: the root is a three-row menu and every control
// lives on a sub-page (Account / Integrations / Training Profile). The sub-page
// mounts on top of this overlay and registers its OWN dismiss handler, so back /
// Escape pops one level at a time — sub-page, then hub.
//
// The flows that replace the whole screen (backup, restore, delete account, the
// coach) still close settings first, as they always did: their handlers come in
// from RunningCoach already wired that way.
export function SettingsModal({initialPage, settings, saveSettings, userContext, saveUserContext, user, onBackup, onRestore, onSignOut, onDeleteAccount, onOpenCoach, onImportFile, onClose, onFeedback, showToast, scanImportsNow, plan}: SettingsModalProps) {
  const { t } = useTranslation();
  useDismissable(true, onClose);
  const [page, setPage] = useState<SettingsPage | null>(initialPage ?? null);
  // Back out of a deep-linked page and settings closes: the page was reached
  // from somewhere else (a recorder's "connect a sensor"), so back belongs to
  // that caller, not to a hub menu the user never passed through.
  const leavePage = () => { if (initialPage) onClose(); else setPage(null); };

  return (
    <div className="fixed inset-0 bg-slate-900 z-50 flex flex-col animate-slide-up">
      <header className="flex items-center justify-between px-4 border-b border-slate-800 shrink-0"
        style={{height:"calc(44px + var(--safe-top))", paddingTop:"var(--safe-top)"}}>
        <span className="text-sm font-semibold">{t("settings.title")}</span>
        <button onClick={onClose} aria-label={t("common.close")} className="text-slate-400 hover:text-white text-lg leading-none px-1">x</button>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto p-4 space-y-5" style={{paddingBottom:"calc(1rem + var(--safe-bottom))"}}>
          <SettingsHub onOpen={setPage}/>

          {/* An action, not a fourth destination — hence the rule above it and
              the hint below, rather than another chevron row. */}
          <div className="border-t border-slate-800 pt-4 space-y-1.5">
            <button onClick={onFeedback}
              className="w-full flex items-center justify-between gap-2 px-3.5 py-3 rounded-xl bg-slate-800 border border-orange-500/40 hover:border-orange-500/70 transition-colors">
              <span className="flex items-center gap-2 text-sm font-medium text-orange-300">
                <MessageSquare size={15}/>{t("feedback.settingsRow")}
              </span>
              <span className="text-[10px] font-bold uppercase tracking-wide bg-orange-500/20 text-orange-300 px-1.5 py-0.5 rounded">
                {t("feedback.badge")}
              </span>
            </button>
            <p className="text-[11px] text-slate-500 px-1">{t("feedback.settingsHint")}</p>
          </div>
          {onSignOut && (
            <button onClick={onSignOut}
              className="w-full py-2.5 rounded-xl text-sm font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center gap-2 transition-colors">
              <LogOut size={15}/>{t("settings.signOut")}
            </button>
          )}
        </div>
      </div>

      {/* key: a fresh mount per page so the slide-up enter animation re-fires. */}
      {page && (
        <SubPage key={page} title={t(`settings.hub.${page}.title`)} onBack={leavePage}>
          {page === "account" && (
            <AccountPage settings={settings} saveSettings={saveSettings} user={user}
              onBackup={onBackup} onRestore={onRestore}
              onDeleteAccount={onDeleteAccount} showToast={showToast}/>
          )}
          {page === "integrations" && (
            <IntegrationsPage settings={settings} saveSettings={saveSettings}
              showToast={showToast} scanImportsNow={scanImportsNow} onImportFile={onImportFile}/>
          )}
          {page === "training" && (
            <TrainingProfilePage settings={settings} saveSettings={saveSettings}
              userContext={userContext} saveUserContext={saveUserContext} onOpenCoach={onOpenCoach} plan={plan}/>
          )}
        </SubPage>
      )}
    </div>
  );
}
