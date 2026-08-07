import { useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { INPUT_CLS, LABEL_CLS, USER_CONTEXT_MAX_CHARS, USER_CONTEXT_WARN_CHARS, USER_CONTEXT_NOTICE_CHARS } from "../../constants";
import { HRZones } from "../../views/HRZones";
import { CoachAvatar } from "../../components/CoachAvatar";
import { coachDisplayName, COACH_MARK_IDS, DEFAULT_COACH_MARK, COACH_NAME_MAX } from "../../utils/coachIdentity";
import type { SettingsState, UserContextState } from "../../types";

// Training Profile: what the coach and the plan reason about — your heart-rate
// profile, the standing notes the coach carries between chats, and how the
// coach appears. Your own identity and app-level preferences live on Account.
type TrainingProfilePageProps = {
  settings: SettingsState;
  saveSettings: (settings: SettingsState) => void;
  userContext: UserContextState;
  saveUserContext: (context: UserContextState) => void;
  onOpenCoach?: () => void;
};

export function TrainingProfilePage({ settings, saveSettings, userContext, saveUserContext, onOpenCoach }: TrainingProfilePageProps) {
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

  const sourceCoachName = settings.coachName || "";
  const [coachNameSource, setCoachNameSource] = useState(sourceCoachName);
  const [coachName, setCoachName] = useState(sourceCoachName);
  if (sourceCoachName !== coachNameSource) {
    setCoachNameSource(sourceCoachName);
    setCoachName(sourceCoachName);
  }
  const commitCoachName = () => {
    const v = coachDisplayName(coachName);
    if ((v ?? "") !== sourceCoachName) saveSettings({ ...settings, coachName: v ?? undefined });
  };
  const mark = settings.coachAvatar && COACH_MARK_IDS.includes(settings.coachAvatar)
    ? settings.coachAvatar : DEFAULT_COACH_MARK;

  return (
    <>
      <div className="bg-slate-800 rounded-2xl p-4">
        <HRZones settings={settings} saveSettings={saveSettings}/>
      </div>

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

      <div className="bg-slate-800 rounded-2xl p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold text-slate-200">{t("settings.coachIdentity.title")}</p>
          <p className="text-xs text-slate-400 mt-1">{t("settings.coachIdentity.desc")}</p>
        </div>
        <div>
          <span className={LABEL_CLS}>{t("settings.coachIdentity.avatarLabel")}</span>
          <div role="radiogroup" aria-label={t("settings.coachIdentity.avatarLabel")} className="flex flex-wrap gap-2">
            {COACH_MARK_IDS.map(id => (
              <button key={id} type="button" role="radio" aria-checked={mark === id}
                aria-label={t("settings.coachIdentity.marks." + id)}
                onClick={() => { if (id !== mark) saveSettings({ ...settings, coachAvatar: id }); }}
                className={"w-11 h-11 rounded-full flex items-center justify-center transition-colors " +
                  (mark === id ? "bg-orange-500/20 ring-2 ring-orange-400 text-orange-400" : "bg-slate-700 text-slate-300 hover:bg-slate-600")}>
                <CoachAvatar id={id} size={18}/>
              </button>
            ))}
          </div>
        </div>
        <div>
          <label htmlFor="coach-name" className={LABEL_CLS}>{t("settings.coachIdentity.nameLabel")}</label>
          <input id="coach-name" type="text" maxLength={COACH_NAME_MAX} value={coachName} placeholder={t("coach.title")}
            onChange={e => setCoachName(e.target.value)} onBlur={commitCoachName}
            onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} className={INPUT_CLS}/>
        </div>
      </div>
    </>
  );
}
