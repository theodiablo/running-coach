import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDismissable } from "../hooks/useDismissable";
import { Check } from "lucide-react";
import { RunFields } from "../components/RunFields";
import { runFormComplete, runFormToPatch, runToForm, type RunFormValues } from "../utils/runForm";
import type { Run, RunPatch } from "../types";

type EditRunModalProps = {
  run: Run;
  onSave: (patch: RunPatch) => void;
  onClose: () => void;
};

// Edit an existing run — mirrors the fields on the Log a Run form.
export function EditRunModal({run, onSave, onClose}: EditRunModalProps) {
  const { t } = useTranslation();
  useDismissable(true, onClose);
  const [f, setF] = useState<RunFormValues>(() => runToForm(run));
  const [err, setErr] = useState("");
  const set = (k: keyof RunFormValues, v: string | number) => setF(prev => ({...prev, [k]: v}));

  const save = () => {
    if (!runFormComplete(f)) { setErr(t("log.validation.required")); return; }
    onSave(runFormToPatch(f));
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-end justify-center p-4 animate-overlay-fade" onClick={onClose}
      style={{ paddingBottom: "calc(1rem + var(--safe-bottom))" }}>
      <div className="bg-slate-800 rounded-2xl w-full max-w-lg border border-slate-700 flex flex-col max-h-[90vh] overflow-hidden animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center px-4 py-3 border-b border-slate-700 shrink-0">
          <p className="font-semibold text-sm">{t("log.edit.title")}</p>
          <button onClick={onClose} aria-label={t("common.close")} className="text-slate-400 hover:text-white text-lg leading-none px-1">x</button>
        </div>
        <div className="p-4 space-y-4 overflow-y-auto">
          <RunFields form={f} onChange={set} phScope="log.edit"/>
          {err && <p className="text-xs text-red-400">{err}</p>}
          <button onClick={save}
            className="w-full bg-orange-500 hover:bg-orange-600 text-white py-3 rounded-xl font-semibold transition-colors flex items-center justify-center gap-2">
            <Check size={18}/>{t("log.edit.saveChanges")}
          </button>
        </div>
      </div>
    </div>
  );
}
