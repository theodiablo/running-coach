import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader } from "lucide-react";
import { useDismissable } from "../hooks/useDismissable";
import { ToggleSwitch } from "../components/ToggleSwitch";
import type { FieldChoice, MyMembership } from "../raceField";

// How the runner appears in one race's field: by name, as a number, or not at all
// (docs/race-field.md). Dismissing it is "not this time".
type FieldJoinSheetProps = {
  publicName: string | null;
  current: MyMembership | null;
  // The others already in the field, when it's open; null shows the "be one of the first" line.
  others: number | null;
  hasGoal: boolean;
  onSetName: () => void;
  onDone: (choice: FieldChoice, showGoal: boolean) => Promise<boolean>;
  onClose: () => void;
};

export function FieldJoinSheet({ publicName, current, others, hasGoal, onSetName, onDone, onClose }: FieldJoinSheetProps) {
  const { t } = useTranslation();
  useDismissable(true, onClose);
  const [choice, setChoice] = useState<FieldChoice>(current?.visibility ?? (publicName ? "named" : "count"));
  const [showGoal, setShowGoal] = useState(current ? current.goalSec != null : false);
  const [saving, setSaving] = useState(false);

  const done = async () => {
    setSaving(true);
    const picked: FieldChoice = choice === "named" && !publicName ? "count" : choice;
    const ok = await onDone(picked, picked === "named" && showGoal && hasGoal);
    setSaving(false);
    if (ok) onClose();
  };

  const option = (id: FieldChoice, title: string, hint: string, disabled = false) => {
    const on = choice === id;
    return (
      <button key={id} type="button" role="radio" aria-checked={on} disabled={disabled} onClick={() => setChoice(id)}
        className={"w-full flex items-center gap-3 min-h-[56px] px-3.5 py-2.5 rounded-xl border text-left transition-colors disabled:opacity-50 "
          + (on ? "border-orange-500 bg-orange-500/10" : "border-slate-600 hover:border-slate-500")}>
        <span className={"shrink-0 w-5 h-5 rounded-full box-border " + (on ? "border-[6px] border-orange-500" : "border-2 border-slate-500")}/>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-slate-100">{title}</span>
          <span className="block text-xs text-slate-400">{hint}</span>
        </span>
      </button>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-[2000] flex items-end animate-overlay-fade" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={t("races.field.join.title")}
        className="w-full max-h-full overflow-y-auto bg-slate-800 border-t border-slate-700 rounded-t-2xl p-4 space-y-3 animate-slide-up"
        style={{ paddingBottom: "calc(1.5rem + var(--safe-bottom))" }}
        onClick={e => e.stopPropagation()}>
        <div className="w-9 h-1 rounded-full bg-slate-600 mx-auto mb-1"/>
        <div>
          <h3 className="text-base font-bold text-white">{t("races.field.join.title")}</h3>
          <p className="text-sm text-slate-300 mt-1">
            {others != null ? t("races.field.join.bodyOpen", { count: others }) : t("races.field.join.bodyFirst")}
          </p>
        </div>

        <div role="radiogroup" aria-label={t("races.field.join.how")} className="space-y-2">
          {publicName
            ? option("named", t("races.field.join.named", { name: publicName }), t("races.field.join.namedHint"))
            : option("named", t("races.field.join.namedNoName"), t("races.field.join.namedNoNameHint"), true)}
          {!publicName && (
            <button type="button" onClick={onSetName} className="text-xs font-semibold text-orange-300 hover:text-orange-200 px-1">
              {t("races.field.join.setName")}
            </button>
          )}
          {option("count", t("races.field.join.count"), t("races.field.join.countHint"))}
          {option("none", t("races.field.join.none"), t("races.field.join.noneHint"))}
        </div>

        {choice === "named" && publicName && hasGoal && (
          <div className="flex items-center gap-3 rounded-xl bg-slate-900/60 px-3.5 py-2.5">
            <span className="flex-1 text-sm text-slate-200">{t("races.field.join.goal")}</span>
            <ToggleSwitch on={showGoal} onToggle={() => setShowGoal(v => !v)} label={t("races.field.join.goal")}/>
          </div>
        )}
        {current?.visibility === "named" && choice === "count" && (
          <p className="text-xs text-slate-400">{t("races.field.join.nameLeaves")}</p>
        )}

        <button type="button" onClick={done} disabled={saving}
          className="w-full flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-60 text-white py-3 rounded-xl text-sm font-bold transition-colors">
          {saving && <Loader size={15} className="animate-spin"/>}{t("races.field.join.done")}
        </button>
        <p className="text-xs text-slate-500 text-center">{t("races.field.join.footer")}</p>
      </div>
    </div>
  );
}
