import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDismissable } from "../hooks/useDismissable";
import type { Plan, RouteBackup, Run, SettingsState, UserContextState } from "../types";
import type { StretchLogEntry } from "../utils/stretchSuggest";

type BackupPayload = {
  runs?: Run[];
  plan?: Plan | null;
  settings?: Partial<SettingsState>;
  routes?: RouteBackup[];
  userContext?: UserContextState;
  stretchLog?: StretchLogEntry[];
};

type RestoreModalProps = { onRestore: (payload: BackupPayload) => void; onClose: () => void };

export function RestoreModal({onRestore, onClose}: RestoreModalProps) {
  const { t } = useTranslation();
  useDismissable(true, onClose);
  const [text, setText] = useState("");
  const [err,  setErr]  = useState("");
  const attempt = () => {
    try {
      const d = JSON.parse(text.trim()) as BackupPayload;
      if (!d.runs && !d.plan && !d.userContext) { setErr(t("settings.restore.invalidBackup")); return; }
      onRestore(d); onClose();
    } catch { setErr(t("settings.restore.invalidJson")); }
  };
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-end justify-center p-4 animate-overlay-fade" onClick={onClose}
      style={{ paddingBottom: "calc(1rem + var(--safe-bottom))" }}>
      <div className="bg-slate-800 rounded-2xl w-full max-w-lg border border-slate-700 overflow-hidden animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center px-4 py-3 border-b border-slate-700">
          <p className="font-semibold text-sm">{t("settings.restore.title")}</p>
          <button onClick={onClose} aria-label={t("common.close")} className="text-slate-400 hover:text-white text-lg leading-none px-1">x</button>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-xs text-slate-400">{t("settings.restore.desc")}</p>
          <textarea value={text} onChange={e => { setText(e.target.value); setErr(""); }} rows={6}
            placeholder={t("settings.restore.placeholder")}
            className="w-full bg-slate-900 border border-slate-700 rounded-xl p-3 text-xs text-slate-300 font-mono resize-none focus:outline-none focus:border-orange-400"/>
          {err && <p className="text-xs text-red-400">{err}</p>}
          <button onClick={attempt} disabled={!text.trim()}
            className="w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-white py-2.5 rounded-xl text-sm font-semibold transition-colors">
            {t("settings.restore.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
