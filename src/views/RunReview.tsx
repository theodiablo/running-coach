import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, HeartPulse, Loader } from "lucide-react";
import { INPUT_CLS, LABEL_CLS } from "../constants";
import { DurationInput } from "../components/DurationInput";
import { useSessionLink } from "../hooks/useSessionLink";
import { currentLocaleTag } from "../i18n";
import { RUN_ACTIVITIES } from "../types";
import type { Run } from "../types";
import { carryPrefill } from "../utils/carryPrefill";
import { fmt, ymd } from "../utils/format";
import { routeSketchPath } from "../utils/routeSketch";
import {
  EFFORT_UNSET, durToSec, paceWarning, runFormComplete, runFormErrors, runFormToPatch, secToDur, setRunField,
  type RunFormValues,
} from "../utils/runForm";
import type { RunPrefill } from "../utils/runPrefill";

const RUN_TYPES = ["EASY", "LONG", "TEMPO", "INTERVALS", "RACE", "WALK"];
const SKETCH_W = 320, SKETCH_H = 112;

type RunReviewProps = {
  addRuns: (runs: Partial<Run>[], opts?: { celebrated?: boolean; fresh?: boolean }) => Run[];
  onDone: () => void;
  onSaved?: (saved: Run[], link: { wNum: number; sId: string } | null) => void;
  prefill: RunPrefill;
};

// A run a device measured (tracker, indoor recorder, watch import): the measurement is shown, not
// asked, and changing it is a deliberate step. What's asked is what only the runner knows: the kind
// of run, how hard it felt, anything to note. Typing a run in is LogView's job.
export function RunReview({ addRuns, onDone, onSaved, prefill }: RunReviewProps) {
  const { t } = useTranslation();
  const indoor = prefill.source === "indoor";
  const recorded: RunFormValues = {
    date: prefill.date || ymd(new Date()),
    type: indoor ? "OTHER" : prefill.type || "EASY",
    activity: prefill.activity || "",
    km: indoor ? "" : prefill.km != null ? String(prefill.km) : "",
    dur: secToDur(prefill.durationSec || 0),
    hr: prefill.hr != null ? String(prefill.hr) : "",
    hrMax: prefill.hrMax != null ? String(prefill.hrMax) : "",
    elev: prefill.elevation != null ? String(prefill.elevation) : "",
    effort: EFFORT_UNSET,
    notes: prefill.notes || "",
  };
  const [f, setF] = useState<RunFormValues>(recorded);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  // Opens by itself only when the measurement can't be saved as it stands.
  const [correcting, setCorrecting] = useState(() =>
    !runFormComplete(recorded) || !!paceWarning(recorded) || (!indoor && !(parseFloat(recorded.km) > 0)));
  const set = (k: keyof RunFormValues, v: string | number) => setF(prev => setRunField(prev, k, v));
  const { linked, fits, session, offered, link, setDeclined, undoable } = useSessionLink(prefill, f);

  const MEASURED = ["date", "km", "dur", "elev", "hr", "hrMax"] as const;
  const edited = MEASURED.some(k => f[k] !== recorded[k]);
  const resetMeasured = () => setF(prev => ({ ...prev, ...Object.fromEntries(MEASURED.map(k => [k, recorded[k]])) }));

  const sec = durToSec(f.dur);
  const km = parseFloat(f.km) || 0;
  const pace = !indoor && km > 0 && sec > 0 ? sec / km : 0;
  const warning = paceWarning(f);
  const recordedFine = !paceWarning(recorded) && runFormComplete(recorded);
  const errors = attempted ? runFormErrors(f) : null;
  const sketch = indoor ? "" : routeSketchPath(prefill.previewTrack, SKETCH_W, SKETCH_H, 14);
  const effort = Number(f.effort);

  const startTime = prefill.startedAt ? new Date(prefill.startedAt) : null;
  const when = fmt.sht(f.date) + (startTime && !Number.isNaN(startTime.getTime())
    ? ", " + startTime.toLocaleTimeString(currentLocaleTag(), { hour: "2-digit", minute: "2-digit" }) : "");
  const kicker = prefill.source === "watch" ? t("log.review.kickerWatch", { when })
    : indoor ? t("log.review.kickerIndoor", { when }) : t("log.review.kickerRun", { when });
  const provenance = edited ? t("log.review.corrected")
    : prefill.source === "watch" ? t("log.review.sourceWatch")
    : indoor ? t("log.review.sourceIndoor") : t("log.review.sourceGps");
  const kmText = km ? String(Math.round(km * 100) / 100) : "--";

  const submit = () => {
    if (!runFormComplete(f)) { setAttempted(true); setCorrecting(true); return; }
    setBusy(true);
    const saved = addRuns([{ ...carryPrefill(prefill), ...runFormToPatch(f) }],
      { celebrated: !!prefill.celebrated, fresh: !prefill.extId && !prefill.hcId });
    setBusy(false); onSaved?.(saved || [], link); onDone();
  };

  const chip = (on: boolean) => "px-3 py-1.5 rounded-full border text-sm transition-colors " + (on
    ? "border-orange-500 bg-orange-500/15 text-orange-300 font-semibold"
    : "border-slate-600 text-slate-200 hover:border-slate-500");
  const stat = (value: string, label: string) => (
    <div className="min-w-0">
      <p className="text-2xl font-bold tabular-nums leading-tight whitespace-nowrap">{value}</p>
      <p className="text-xs text-slate-400">{label}</p>
    </div>
  );
  const recordedNote = (k: typeof MEASURED[number], shown: string) =>
    f[k] !== recorded[k] && recorded[k]
      ? <p className="text-[11px] text-slate-500 mt-1">{t("log.review.recorded", { value: shown })}</p> : null;
  const fid = (name: string) => "review-" + name;
  const optional = <span className="text-xs font-normal text-slate-500">{t("log.fields.optional")}</span>;

  return (
    <div className="p-4 max-w-lg mx-auto">
      <p className="text-xs text-slate-400 mt-4">{kicker}</p>
      <h2 className="text-xl font-bold mb-4">{indoor ? t("log.review.titleIndoor") : t("log.titleReview")}</h2>

      <section className="bg-slate-800 border border-slate-700 rounded-2xl overflow-hidden mb-5">
        {sketch && (
          <svg viewBox={`0 0 ${SKETCH_W} ${SKETCH_H}`} className="block w-full h-28 bg-slate-900/60" aria-hidden="true">
            <path d={sketch} fill="none" stroke="#f97316" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round"/>
          </svg>
        )}
        <div className="grid grid-cols-3 gap-2 px-4 pt-3">
          {indoor ? <>
            {stat(sec ? fmt.dur(sec) : "--", t("log.review.time"))}
            {stat(f.hr || "--", t("log.review.avgHr"))}
            {stat(f.hrMax || "--", t("log.review.maxHr"))}
          </> : <>
            {stat(kmText, t("log.review.km"))}
            {stat(sec ? fmt.dur(sec) : "--", t("log.review.time"))}
            {stat(pace ? fmt.pace(pace) : "--", t("log.review.perKm"))}
          </>}
        </div>
        {!indoor && (f.elev || f.hr) && (
          <p className="flex flex-wrap gap-x-3 gap-y-1 px-4 pt-1.5 text-xs text-slate-300">
            {f.elev && <span>↑ {t("log.review.climb", { m: f.elev })}</span>}
            {f.hr && <span>♥ {f.hrMax ? t("log.review.hr", { avg: f.hr, max: f.hrMax }) : t("log.review.hrAvg", { avg: f.hr })}</span>}
          </p>
        )}
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 mt-3 border-t border-slate-700 text-xs text-slate-400">
          <span>{provenance}</span>
          <button type="button" onClick={() => setCorrecting(c => !c)} aria-expanded={correcting} aria-controls={fid("correct")}
            className="font-semibold text-orange-300 hover:text-orange-200 underline underline-offset-2">
            {correcting ? t("log.review.correctDone") : t("log.review.correct")}
          </button>
        </div>
        {correcting && (
          <div id={fid("correct")} className="px-4 pb-4 pt-1 space-y-3 border-t border-slate-700 animate-expand">
            <div className="grid grid-cols-2 gap-3 pt-2">
              {!indoor && (
                <div><label className={LABEL_CLS} htmlFor={fid("km")}>{t("log.fields.distanceKm")}</label>
                  <input id={fid("km")} type="number" step="0.01" min="0" value={f.km} onChange={e => set("km", e.target.value)}
                    aria-invalid={errors?.km || undefined}
                    className={errors?.km ? INPUT_CLS.replace("border-slate-600", "border-red-400") : INPUT_CLS}/>
                  {errors?.km && <p className="text-xs text-red-300 mt-1">{t("log.validation.km")}</p>}
                  {recordedNote("km", recorded.km)}</div>
              )}
              <div><label className={LABEL_CLS} htmlFor={fid("dur")}>{t("log.fields.duration")}</label>
                <DurationInput id={fid("dur")} value={f.dur} onChange={v => set("dur", v)} placeholder={t("log.fields.durationPh")}
                  aria-invalid={errors?.duration || undefined}
                  className={(errors?.duration ? INPUT_CLS.replace("border-slate-600", "border-red-400") : INPUT_CLS) + " tabular-nums"}/>
                {errors?.duration && <p className="text-xs text-red-300 mt-1">{t("log.validation.duration")}</p>}
                {recordedNote("dur", fmt.dur(durToSec(recorded.dur)))}</div>
              <div><label className={LABEL_CLS} htmlFor={fid("date")}>{t("log.fields.date")}</label>
                <input id={fid("date")} type="date" value={f.date} onChange={e => set("date", e.target.value)} className={INPUT_CLS}/>
                {recordedNote("date", fmt.sht(recorded.date))}</div>
              {!indoor && (
                <div><label className={LABEL_CLS} htmlFor={fid("elev")}>{t("log.fields.elevM")}</label>
                  <input id={fid("elev")} type="number" value={f.elev} onChange={e => set("elev", e.target.value)} className={INPUT_CLS}/></div>
              )}
              <div><label className={LABEL_CLS} htmlFor={fid("hr")}>{t("log.fields.avgHr")}</label>
                <input id={fid("hr")} type="number" min="0" max="250" value={f.hr} onChange={e => set("hr", e.target.value)} className={INPUT_CLS}/></div>
              <div><label className={LABEL_CLS} htmlFor={fid("hrMax")}>{t("log.fields.maxHr")}</label>
                <input id={fid("hrMax")} type="number" min="0" max="250" value={f.hrMax} onChange={e => set("hrMax", e.target.value)} className={INPUT_CLS}/></div>
            </div>
            {warning && (
              <div role="status" className="flex gap-2 text-xs text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2.5">
                <AlertTriangle size={14} className="shrink-0 mt-0.5"/>
                <div>
                  <p>{t(warning.kind === "fast" ? "log.fields.paceFast" : "log.fields.paceSlow", { pace: fmt.pace(warning.pace) })}</p>
                  {edited && recordedFine && (
                    <button type="button" onClick={resetMeasured} className="mt-1 font-semibold underline underline-offset-2">
                      {t("log.review.useRecorded", { value: recorded.km && !indoor
                        ? `${recorded.km} km, ${fmt.dur(durToSec(recorded.dur))}` : fmt.dur(durToSec(recorded.dur)) })}
                    </button>
                  )}
                </div>
              </div>
            )}
            {edited && !warning && (
              <button type="button" onClick={resetMeasured} className="text-xs text-slate-400 hover:text-slate-200 underline underline-offset-2">
                {t("log.review.backToRecorded")}
              </button>
            )}
          </div>
        )}
      </section>

      {session && (
        <div className="flex gap-2.5 bg-orange-500/10 border border-orange-500/25 rounded-xl px-3.5 py-3 mb-5">
          <Check size={16} className="text-orange-300 shrink-0 mt-0.5"/>
          <div className="space-y-0.5">
            <p className="text-sm font-semibold text-white">
              {offered
                ? t("log.session.offerHeading", { date: fmt.sht(session.date) })
                : t("log.session.heading", { week: session.wNum, date: fmt.sht(session.date) })}
            </p>
            <p className="text-xs text-slate-400">{t("log.session.ticksOff")}</p>
            {offered && (
              <button type="button" onClick={() => setDeclined(true)}
                className="pt-1 text-xs font-semibold text-slate-400 hover:text-slate-200 underline underline-offset-2">
                {t("log.session.decline")}
              </button>
            )}
          </div>
        </div>
      )}
      {undoable && prefill.session && (
        <button type="button" onClick={() => setDeclined(false)}
          className="w-full text-xs text-slate-500 hover:text-slate-300 underline underline-offset-2 mb-5">
          {t("log.session.declineUndo", { date: fmt.sht(prefill.session.date) })}
        </button>
      )}
      {linked && !fits && (
        <p className="text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/25 rounded-xl px-4 py-2.5 mb-5">
          {t("log.session.noLongerFits", { date: fmt.sht(linked.date) })}
        </p>
      )}

      <div className="space-y-5">
        <div role="group" aria-labelledby={fid("q-type")}>
          <p id={fid("q-type")} className="text-sm font-semibold mb-2">{indoor ? t("log.review.qMachine") : t("log.review.qType")}</p>
          <div className="flex flex-wrap gap-2">
            {indoor
              ? RUN_ACTIVITIES.map(a => (
                <button key={a} type="button" aria-pressed={f.activity === a} className={chip(f.activity === a)}
                  onClick={() => set("activity", f.activity === a ? "" : a)}>{t("common.activities." + a)}</button>))
              : RUN_TYPES.map(ty => (
                <button key={ty} type="button" aria-pressed={f.type === ty} className={chip(f.type === ty)}
                  onClick={() => set("type", ty)}>{t("common.types." + ty, { defaultValue: ty })}</button>))}
          </div>
          {!indoor && (session && f.type === session.type
            ? <p className="text-xs text-slate-400 mt-2">{t("log.review.qTypeFromPlan")}</p>
            : f.type === "EASY" && <p className="text-xs text-slate-400 mt-2">{t("log.review.qTypeDefault")}</p>)}
        </div>

        <div role="group" aria-labelledby={fid("q-effort")}>
          <p id={fid("q-effort")} className="flex items-baseline justify-between text-sm font-semibold mb-2">
            {t("log.review.qEffort")} {optional}
          </p>
          {/* Nothing picked is "didn't say" (EFFORT_UNSET), never a middle value; a second tap clears it. */}
          <div className="grid grid-cols-10 gap-1">
            {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
              <button key={n} type="button" aria-pressed={effort === n} aria-label={t("log.review.effortButton", { value: n })}
                onClick={() => set("effort", effort === n ? EFFORT_UNSET : n)}
                className={"h-9 rounded-lg border text-sm font-semibold tabular-nums transition-colors " + (effort === n
                  ? "bg-orange-500 border-orange-500 text-white"
                  : "border-slate-600 text-slate-300 hover:border-slate-500")}>{n}</button>
            ))}
          </div>
          <div className="flex justify-between text-[11px] text-slate-500 mt-1">
            <span>{t("log.fields.effortEasy")}</span>
            <span className={effort > EFFORT_UNSET ? "text-orange-300 font-semibold" : ""}>
              {effort > EFFORT_UNSET ? t("log.fields.effortValue", { value: effort }) : t("log.fields.effortSteady")}
            </span>
            <span>{t("log.fields.effortMax")}</span>
          </div>
        </div>

        <div>
          <label htmlFor={fid("notes")} className="flex items-baseline justify-between text-sm font-semibold mb-2">
            {t("log.review.qNotes")} {optional}
          </label>
          <textarea id={fid("notes")} rows={2} placeholder={t("log.review.notesPh")} value={f.notes}
            onChange={e => set("notes", e.target.value)} className={INPUT_CLS + " resize-none"}/>
        </div>

        {(prefill.hrPending || prefill.hrPendingHk) && !f.hr && (
          <p className="text-xs text-slate-400 flex items-start gap-1.5">
            <HeartPulse size={14} className="text-red-400 mt-0.5 shrink-0"/>
            <span>{t("log.review.hrPendingNote", { store: prefill.hrPendingHk ? "Apple Health" : "Health Connect" })}</span>
          </p>
        )}

        <button type="button" onClick={submit} disabled={busy}
          className="w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white py-3.5 rounded-xl font-semibold transition-colors flex items-center justify-center gap-2">
          {busy ? <Loader size={18} className="animate-spin"/> : session ? <Check size={18}/> : null}
          {session ? t("log.saveAndTick") : indoor ? t("log.review.saveSession") : t("log.saveRun")}
        </button>
        {attempted && !runFormComplete(f) && (
          <p className="text-xs text-red-300 text-center -mt-2">{t("log.validation.fixAbove")}</p>
        )}
      </div>
    </div>
  );
}
