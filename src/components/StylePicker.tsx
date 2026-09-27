import { useTranslation } from "react-i18next";
import { STYLE_IDS, styleMeta, type StyleId } from "../utils/planStyles";
import { RUNWALK_RUN_OPTIONS, RUNWALK_WALK_OPTIONS, type RunWalkConfig } from "../utils/runwalk";
import { fmt } from "../utils/format";

// Radio-card picker for the training methodology style, shared by PlanView's
// setup/edit forms and the onboarding wizard. `recommended` tags (and, while
// the user hasn't picked, usually equals) the profile-derived suggestion from
// recommendStyle. The Run/Walk card opens its ratio control when selected —
// the one place the ratio is set, so both forms get it from one component.
type StylePickerProps = {
  value: StyleId;
  onChange: (style: StyleId) => void;
  recommended?: StyleId | null;
  runWalk?: RunWalkConfig;
  onRunWalkChange?: (cfg: RunWalkConfig) => void;
};

function RatioRow({ label, value, options, onChange }: {
  label: string; value: number; options: number[]; onChange: (sec: number) => void;
}) {
  return (
    <div>
      <p className="text-[11px] text-slate-400 mb-1.5">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map(sec => (
          <button key={sec} type="button" onClick={() => onChange(sec)}
            aria-pressed={sec === value}
            className={"px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-colors " + (sec === value
              ? "bg-orange-500 border-orange-500 text-white"
              : "bg-slate-800 border-slate-600 text-slate-300 hover:border-slate-500")}>
            {fmt.interval(sec)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function StylePicker({ value, onChange, recommended, runWalk, onRunWalkChange }: StylePickerProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      {(STYLE_IDS as StyleId[]).map(id => {
        const meta = styleMeta(id);
        const selected = id === value;
        const cardCls = "w-full text-left rounded-xl border p-3 transition-colors " +
          (selected ? "bg-orange-500/15 border-orange-500/60" : "bg-slate-700/40 border-slate-600 hover:border-slate-500");
        const showRatio = selected && id === "runwalk" && runWalk && onRunWalkChange;
        return (
          <div key={id} className={cardCls}>
            <button type="button" onClick={() => onChange(id)} className="w-full text-left">
              <div className="flex items-center gap-2">
                <span className={"text-sm font-semibold " + (selected ? "text-orange-300" : "text-white")}>{meta.label}</span>
                {recommended === id && (
                  <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-300 flex-shrink-0">
                    {t("styles.recommended")}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-1 leading-snug">{meta.blurb}</p>
            </button>
            {showRatio && (
              <div className="mt-3 pt-3 border-t border-orange-500/25 space-y-3">
                <p className="text-xs font-semibold text-slate-200">{t("styles.runWalk.title")}</p>
                <RatioRow label={t("styles.runWalk.runLabel")} value={runWalk.runSec}
                  options={RUNWALK_RUN_OPTIONS} onChange={sec => onRunWalkChange({ ...runWalk, runSec: sec })}/>
                <RatioRow label={t("styles.runWalk.walkLabel")} value={runWalk.walkSec}
                  options={RUNWALK_WALK_OPTIONS} onChange={sec => onRunWalkChange({ ...runWalk, walkSec: sec })}/>
                <p className="text-[11px] text-slate-500 leading-snug">{t("styles.runWalk.note")}</p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
