import { useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { INPUT_CLS, USER_CONTEXT_MAX_CHARS, USER_CONTEXT_WARN_CHARS, USER_CONTEXT_NOTICE_CHARS } from "../../constants";
import { HRZones } from "../../views/HRZones";
import { SessionRemindersCard } from "../../components/SessionRemindersCard";
import type { Plan, SettingsState, UserContextState } from "../../types";

// Training Profile: what the coach and the plan reason about — your heart-rate
// profile and the standing notes the coach carries between chats. Identity and
// app-level preferences live on Account instead.
type TrainingProfilePageProps = {
  settings: SettingsState;
  saveSettings: (settings: SettingsState) => void;
  userContext: UserContextState;
  saveUserContext: (context: UserContextState) => void;
  onOpenCoach?: () => void;
  plan?: Plan | null;
};

export function TrainingProfilePage({ settings, saveSettings, userContext, saveUserContext, onOpenCoach, plan }: TrainingProfilePageProps) {
  const { t } = useTranslation();
  const sourceMemory = userContext?.notes || "";
  const [memorySource, setMemorySource] = useState(sourceMemory);
  const [memory, setMemory] = useState(sourceMemory);
  if (sourceMemory !== memorySource) {
    setMemorySource(sourceMemory);
    setMemory(sourceMemory);
  }
  // Auto-save on blur — no Save button (matches the HR fields above).
  const commitMemory = () => {
    const notes = memory.slice(0, USER_CONTEXT_MAX_CHARS);
    if (notes !== (userContext?.notes || "")) saveUserContext({ ...(userContext || {}), notes });
  };

  return (
    <>
      <div className="bg-slate-800 rounded-2xl p-4">
        <HRZones settings={settings} saveSettings={saveSettings}/>
      </div>

      <SessionRemindersCard settings={settings} saveSettings={saveSettings} plan={plan ?? null}/>

      <div className="bg-slate-800 rounded-2xl p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold text-slate-200">{t("settings.memory.title")}</p>
          <p className="text-xs text-slate-400 mt-1">{t("settings.memory.desc")}</p>
        </div>
        <textarea value={memory} maxLength={USER_CONTEXT_MAX_CHARS} rows={6}
          onChange={e => setMemory(e.target.value)} onBlur={commitMemory}
          placeholder={t("settings.memory.placeholder")}
          className={INPUT_CLS + " resize-none leading-relaxed"}/>
        <div className="flex items-center justify-between gap-3 text-xs">
          <p className="text-slate-500">
            <Trans i18nKey="settings.memory.footer" components={{
              link: onOpenCoach
                ? <button type="button" onClick={onOpenCoach}
                    className="text-orange-400 hover:text-orange-300 underline underline-offset-2"/>
                : <span/>,
            }}/>
          </p>
          <p className={memory.length >= USER_CONTEXT_NOTICE_CHARS ? "text-red-400" : memory.length >= USER_CONTEXT_WARN_CHARS ? "text-amber-400" : "text-slate-500"}>
            {memory.length} / {USER_CONTEXT_MAX_CHARS}
          </p>
        </div>
      </div>
    </>
  );
}
