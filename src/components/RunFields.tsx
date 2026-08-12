import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { INPUT_CLS, LABEL_CLS } from "../constants";
import { RUN_ACTIVITIES } from "../types";
import type { RunFormValues } from "../utils/runForm";

const RUN_TYPES = ["EASY", "TEMPO", "LONG", "INTERVALS", "RACE", "WALK", "OTHER"];

type RunFieldsProps = {
  form: RunFormValues;
  onChange: (key: keyof RunFormValues, value: string | number) => void;
  // Log teaches with "e.g. 8.5"; Edit shows a bare "8.5" next to a filled field.
  phScope: "log.fields" | "log.edit";
  // Slot under the HR row — Log uses it for the pending-HR note.
  afterHr?: ReactNode;
};

export function RunFields({ form: f, onChange: set, phScope, afterHr }: RunFieldsProps) {
  const { t } = useTranslation();
  // Literal keys, not t(phScope + ".kmPh"): i18n.test.ts's dangling-key scanner
  // only sees literals, and these would silently rot in a locale-file cleanup.
  const ph = phScope === "log.edit"
    ? { km: t("log.edit.kmPh"), avgHr: t("log.edit.avgHrPh"), maxHr: t("log.edit.maxHrPh"), elev: t("log.edit.elevPh") }
    : { km: t("log.fields.kmPh"), avgHr: t("log.fields.avgHrPh"), maxHr: t("log.fields.maxHrPh"), elev: t("log.fields.elevPh") };
  const isCross = f.type === "OTHER";
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div><label className={LABEL_CLS}>{t("log.fields.date")}</label>
          <input type="date" value={f.date} onChange={e => set("date", e.target.value)} className={INPUT_CLS}/></div>
        <div><label className={LABEL_CLS}>{t("log.fields.type")}</label>
          <select value={f.type} onChange={e => set("type", e.target.value)} className={INPUT_CLS}>
            {RUN_TYPES.map(ty =>
              <option key={ty} value={ty}>{t("common.types." + ty, { defaultValue: ty })}</option>)}
          </select>
        </div>
      </div>
      {/* Cross-training only: which machine, and a distance that may not exist
          (an old stationary bike measures nothing comparable to running km). */}
      {isCross && (
        <div><label className={LABEL_CLS}>{t("log.fields.activity")}</label>
          <select value={f.activity} onChange={e => set("activity", e.target.value)} className={INPUT_CLS}>
            <option value="">{t("log.fields.activityNone")}</option>
            {RUN_ACTIVITIES.map(a =>
              <option key={a} value={a}>{t("common.activities." + a)}</option>)}
          </select>
        </div>
      )}
      <div><label className={LABEL_CLS}>{isCross ? t("log.fields.distanceKmOptional") : t("log.fields.distanceKm")}</label>
        <input type="number" step="0.01" min="0" placeholder={ph.km} value={f.km}
          onChange={e => set("km", e.target.value)} className={INPUT_CLS}/></div>
      <div><label className={LABEL_CLS}>{t("log.fields.duration")}</label>
        <div className="grid grid-cols-3 gap-2">
          <input type="number" min="0" max="23" placeholder={t("log.fields.hoursPh")}   value={f.dH} onChange={e => set("dH", e.target.value)} className={INPUT_CLS}/>
          <input type="number" min="0" max="59" placeholder={t("log.fields.minutesPh")} value={f.dM} onChange={e => set("dM", e.target.value)} className={INPUT_CLS}/>
          <input type="number" min="0" max="59" placeholder={t("log.fields.secondsPh")} value={f.dS} onChange={e => set("dS", e.target.value)} className={INPUT_CLS}/>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div><label className={LABEL_CLS}>{t("log.fields.avgHr")}</label>
          <input type="number" placeholder={ph.avgHr} value={f.hr} onChange={e => set("hr", e.target.value)} className={INPUT_CLS}/></div>
        <div><label className={LABEL_CLS}>{t("log.fields.maxHr")}</label>
          <input type="number" placeholder={ph.maxHr} value={f.hrMax} onChange={e => set("hrMax", e.target.value)} className={INPUT_CLS}/></div>
        <div><label className={LABEL_CLS}>{t("log.fields.elevM")}</label>
          <input type="number" placeholder={ph.elev} value={f.elev} onChange={e => set("elev", e.target.value)} className={INPUT_CLS}/></div>
      </div>
      {afterHr}
      <div>
        <label className={LABEL_CLS}>{t("log.fields.effort")} <span className="text-white font-semibold">{t("log.fields.effortValue", { value: f.effort })}</span></label>
        <input type="range" min="1" max="10" value={f.effort} onChange={e => set("effort", e.target.value)} className="w-full accent-orange-500"/>
      </div>
      <div><label className={LABEL_CLS}>{t("log.fields.notes")}</label>
        <textarea rows={2} placeholder={t("log.fields.notesPh")} value={f.notes}
          onChange={e => set("notes", e.target.value)} className={INPUT_CLS + " resize-none"}/></div>
    </>
  );
}
