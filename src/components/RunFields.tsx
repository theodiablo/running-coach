import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Plus } from "lucide-react";
import { INPUT_CLS, LABEL_CLS } from "../constants";
import { RUN_ACTIVITIES } from "../types";
import { fmt } from "../utils/format";
import { EFFORT_UNSET, durToSec, formatDur, normalizeDur, type RunFormErrors, type RunFormValues } from "../utils/runForm";

const RUN_TYPES = ["EASY", "TEMPO", "LONG", "INTERVALS", "RACE", "WALK", "OTHER"];

// Two tiers. What a logged run actually needs — when, what, how far, how long —
// is always visible; heart rate, elevation, effort and notes sit behind one row,
// because they are usually left empty and used to push Save below the fold. The
// section opens filled when the form already carries any of them (a watch
// import, an edit), so nothing arrives hidden.
type RunFieldsProps = {
  form: RunFormValues;
  onChange: (key: keyof RunFormValues, value: string | number) => void;
  // Log teaches with "e.g. 8.5"; Edit shows a bare "8.5" next to a filled field.
  phScope: "log.fields" | "log.edit";
  // Slot under the HR row — Log uses it for the pending-HR note.
  afterHr?: ReactNode;
  // Set once a save has been attempted, so the required fields explain
  // themselves in place rather than through a banner off the top of the screen.
  errors?: RunFormErrors | null;
  detailsOpen?: boolean;
};

export function RunFields({ form: f, onChange: set, phScope, afterHr, errors, detailsOpen = false }: RunFieldsProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(detailsOpen);
  // Literal keys, not t(phScope + ".kmPh"): i18n.test.ts's dangling-key scanner
  // only sees literals, and these would silently rot in a locale-file cleanup.
  const ph = phScope === "log.edit"
    ? { km: t("log.edit.kmPh"), avgHr: t("log.edit.avgHrPh"), maxHr: t("log.edit.maxHrPh"), elev: t("log.edit.elevPh") }
    : { km: t("log.fields.kmPh"), avgHr: t("log.fields.avgHrPh"), maxHr: t("log.fields.maxHrPh"), elev: t("log.fields.elevPh") };
  const isCross = f.type === "OTHER";
  const optional = <span className="text-slate-500">{t("log.fields.optional")}</span>;
  // Swap the border colour rather than appending one: two border-* utilities
  // have equal specificity, so the winner is whichever Tailwind emits last, not
  // whichever is last in the class attribute.
  const errCls = (bad?: boolean) => bad ? INPUT_CLS.replace("border-slate-600", "border-red-400") : INPUT_CLS;

  // The one number that confirms the entry at a glance — and exposes 80 km or
  // 4 minutes as the typo it is. Meaningless without a running distance.
  const sec = durToSec(f.dur);
  const km = parseFloat(f.km);
  const pace = !isCross && km > 0 && sec > 0 ? sec / km : 0;

  const effort = Number(f.effort);

  const durRef = useRef<HTMLInputElement | null>(null);
  const durId = phScope === "log.edit" ? "run-dur-edit" : "run-dur";
  // React restores the caret by index, which lands it before a colon the format
  // just inserted; put it back at the end after the value settles.
  const pinEnd = () => requestAnimationFrame(() => {
    const el = durRef.current;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  });

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
      {/* Cross-training only: which machine. It gets no distance field — a
          bike's kilometres are not running kilometres, and letting them in
          distorts volume, pace, PBs and the plan's fitness signal. */}
      {isCross && (
        <div><label className={LABEL_CLS}>{t("log.fields.activity")}</label>
          <select value={f.activity} onChange={e => set("activity", e.target.value)} className={INPUT_CLS}>
            <option value="">{t("log.fields.activityNone")}</option>
            {RUN_ACTIVITIES.map(a =>
              <option key={a} value={a}>{t("common.activities." + a)}</option>)}
          </select>
        </div>
      )}
      {!isCross && (
        <div data-field="km"><label className={LABEL_CLS}>{t("log.fields.distanceKm")}</label>
          <input type="number" step="0.01" min="0" placeholder={ph.km} value={f.km}
            onChange={e => set("km", e.target.value)} className={errCls(errors?.km)}/>
          {errors?.km && <p className="text-xs text-red-300 mt-1.5">{t("log.validation.km")}</p>}
        </div>
      )}
      <div data-field="duration"><label className={LABEL_CLS} htmlFor={durId}>{t("log.fields.duration")}</label>
        {/* One masked field, not three boxes: digits fill from the right, so a
            time is typed in the order a watch face shows it. Editing is
            append/backspace only — the caret is pinned to the end, which is
            what keeps this free of caret arithmetic. */}
        <input id={durId} type="text" inputMode="numeric" autoComplete="off"
          placeholder={t("log.fields.durationPh")} value={formatDur(f.dur)}
          onChange={e => { set("dur", normalizeDur(e.target.value)); pinEnd(); }}
          onKeyDown={e => {
            if (e.key !== "Backspace") return;
            e.preventDefault();
            set("dur", f.dur.slice(0, -1));
          }}
          onFocus={pinEnd} onClick={pinEnd}
          onSelect={() => {
            const el = durRef.current;
            if (el && (el.selectionStart !== el.value.length || el.selectionEnd !== el.value.length)) pinEnd();
          }}
          ref={durRef}
          className={errCls(errors?.duration) + " text-lg font-semibold tabular-nums text-center"}/>
        {errors?.duration
          ? <p className="text-xs text-red-300 mt-1.5">{t("log.validation.duration")}</p>
          : !f.dur && <p className="text-xs text-slate-500 mt-1.5">{t("log.fields.durationHint")}</p>}
      </div>

      {pace > 0 && (
        <div className="flex items-baseline justify-between rounded-xl bg-orange-500/10 border border-orange-500/25 px-4 py-2.5">
          <span className="text-xs text-slate-400">{t("log.fields.paceLabel")}</span>
          <span className="text-base font-bold text-orange-300 tabular-nums">{fmt.pace(pace)}/km</span>
        </div>
      )}
      {isCross && <p className="text-xs text-slate-500">{t("log.fields.crossNoDistance")}</p>}

      {!open && (
        <button type="button" onClick={() => setOpen(true)}
          className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-dashed border-slate-600 text-slate-400 hover:text-slate-200 hover:border-slate-500 text-sm font-medium transition-colors">
          <Plus size={14}/>{isCross ? t("log.fields.addDetailsCross") : t("log.fields.addDetails")}
          <ChevronDown size={14}/>
        </button>
      )}

      {open && (
        <div className="space-y-4 animate-expand">
          <div className="grid grid-cols-2 gap-2">
            <div><label className={LABEL_CLS}>{t("log.fields.avgHr")} {optional}</label>
              <input type="number" min="0" max="250" placeholder={ph.avgHr} value={f.hr} onChange={e => set("hr", e.target.value)} className={INPUT_CLS}/></div>
            <div><label className={LABEL_CLS}>{t("log.fields.maxHr")} {optional}</label>
              <input type="number" min="0" max="250" placeholder={ph.maxHr} value={f.hrMax} onChange={e => set("hrMax", e.target.value)} className={INPUT_CLS}/></div>
          </div>
          {afterHr}
          {!isCross && (
            <div><label className={LABEL_CLS}>{t("log.fields.elevM")} {optional}</label>
              <input type="number" placeholder={ph.elev} value={f.elev} onChange={e => set("elev", e.target.value)} className={INPUT_CLS}/></div>
          )}
          <div>
            <label className={LABEL_CLS}>
              {t("log.fields.effort")} <span className={effort > EFFORT_UNSET ? "text-white font-semibold" : "text-slate-500"}>
                {effort > EFFORT_UNSET ? t("log.fields.effortValue", { value: effort }) : t("log.fields.effortUnset")}
              </span>
            </label>
            {/* 0 is "didn't say", not an intensity — see EFFORT_UNSET. */}
            <input type="range" min="0" max="10" value={effort} onChange={e => set("effort", e.target.value)}
              aria-label={t("log.fields.effort")} className="w-full accent-orange-500"/>
            <div className="flex justify-between text-[10px] text-slate-500 -mt-0.5">
              <span>{t("log.fields.effortEasy")}</span>
              <span>{t("log.fields.effortSteady")}</span>
              <span>{t("log.fields.effortMax")}</span>
            </div>
          </div>
          <div><label className={LABEL_CLS}>{t("log.fields.notes")} {optional}</label>
            <textarea rows={2} placeholder={t("log.fields.notesPh")} value={f.notes}
              onChange={e => set("notes", e.target.value)} className={INPUT_CLS + " resize-none"}/></div>
        </div>
      )}
    </>
  );
}
