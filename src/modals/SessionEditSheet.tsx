// The runner's own session editor: day (with swap), type, distance, delete, and
// adding a session. Never refuses on training grounds — what the shared
// validator flags is shown as a heads-up and Save becomes "Save anyway".
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronLeft, ChevronRight, Minus, Plus, Trash2 } from "lucide-react";
import { useDismissable } from "../hooks/useDismissable";
import { ConfirmButtons } from "../components/ModalPrimitives";
import { dayName } from "../i18n";
import { TCLR } from "../constants";
import { fmt, ymd } from "../utils/format";
import { describeSession } from "../utils/sessionDesc";
import {
  EDIT_TYPES, MAX_KM, MIN_KM, applySessionEdit, canPlaceOn, defaultKm, editIssues, isEditableSession, weekOfDate,
  type PlanIssue, type SessionEdit,
} from "../utils/planEdit";
import type { Plan, PlanSession, RunType } from "../types";

export type SessionEditTarget =
  | { kind: "edit"; session: PlanSession; weekNumber: number }
  | { kind: "add"; weekNumber: number; date: string };

type SessionEditSheetProps = {
  plan: Plan;
  target: SessionEditTarget;
  today: string;
  onSave: (edit: SessionEdit, warnings: number) => void;
  onAskCoach: () => void;
  onClose: () => void;
};

const typeClass = (type: string) => TCLR[type as RunType] || TCLR.OTHER;
const dayGap = (a: string, b: string) =>
  Math.round((new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) / 86400000);
const addDays = (s: string, n: number) => {
  const d = new Date(s + "T12:00:00");
  d.setDate(d.getDate() + n);
  return ymd(d);
};
const weekday = (s: string) => (new Date(s + "T12:00:00").getDay() + 6) % 7;

export function SessionEditSheet({ plan, target, today, onSave, onAskCoach, onClose }: SessionEditSheetProps) {
  const { t } = useTranslation();
  useDismissable(true, onClose);

  const orig = target.kind === "edit" ? target.session : null;
  const startWeek = plan.weeks.find(w => w.weekNumber === target.weekNumber) || null;
  const initType = orig ? String(orig.type) : "EASY";
  const [date, setDate] = useState(orig ? orig.date : target.kind === "add" ? target.date : "");
  const [type, setType] = useState(initType);
  const [kmStr, setKmStr] = useState(String(orig ? orig.km : defaultKm(startWeek, "EASY")));
  const [swap, setSwap] = useState(true);
  const [viewStart, setViewStart] = useState(() => weekOfDate(plan, date)?.startDate || startWeek?.startDate || date);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const viewWeek = weekOfDate(plan, viewStart);
  const km = parseFloat(kmStr.replace(",", "."));
  const kmValid = Number.isFinite(km) && km >= MIN_KM && km <= MAX_KM;

  // A day already holding one editable session offers to trade places with it.
  const others = (weekOfDate(plan, date)?.sessions || []).filter(s => s.id !== orig?.id && !s.skipped && s.date === date);
  const swapCand = orig && date !== orig.date && others.length === 1 &&
    isEditableSession(plan, others[0].id, today) && canPlaceOn(plan, orig.date, today) ? others[0] : null;

  const edit: SessionEdit = orig
    ? { kind: "update", sessionId: orig.id, date, type, km, swapWith: swapCand && swap ? swapCand.id : null }
    : { kind: "add", date, type, km };
  const next = kmValid ? applySessionEdit(plan, edit, today) : null;
  const issues = next ? editIssues(plan, next, today) : { warnings: [], blocking: [] };
  const changed = !orig || date !== orig.date || type !== orig.type || km !== Number(orig.km);
  const canSave = !!next && changed && !issues.blocking.length;

  const delNext = orig ? applySessionEdit(plan, { kind: "delete", sessionId: orig.id }, today) : null;
  const delIssues = delNext ? editIssues(plan, delNext, today).warnings : [];

  const stepWeek = (dir: 1 | -1) => {
    const idx = plan.weeks.findIndex(w => w.startDate === viewWeek?.startDate);
    const nw = plan.weeks[idx + dir];
    if (nw?.startDate) setViewStart(nw.startDate);
  };
  const weekHasRoom = (dir: 1 | -1) => {
    const idx = plan.weeks.findIndex(w => w.startDate === viewWeek?.startDate);
    const nw = plan.weeks[idx + dir];
    return !!nw?.startDate && Array.from({ length: 7 }, (_, i) => addDays(nw.startDate!, i)).some(d => canPlaceOn(plan, d, today));
  };

  const setKm = (v: number) => setKmStr(String(Math.min(MAX_KM, Math.max(MIN_KM, Math.round(v * 2) / 2))));
  const pickType = (ty: string) => {
    setType(ty);
    if (!orig) setKmStr(String(defaultKm(weekOfDate(plan, date), ty)));
  };

  const sessOn = (id: string | undefined) => (id && next ? next.weeks.flatMap(w => w.sessions).find(s => s.id === id) : undefined);
  const typeLabel = (ty?: string) => t("common.types." + ty, { defaultValue: ty || "" });
  const issueText = (i: PlanIssue): string => {
    const s = sessOn(i.sessionId);
    const days = s ? dayGap(s.date, String(plan.raceDate || "")) : 0;
    switch (i.code) {
      case "RAMP_EXCEEDED": return t("plan.editor.warn.ramp", { week: i.weekNumber });
      case "HARD_BACK_TO_BACK": return t("plan.editor.warn.backToBack", {
        a: typeLabel(i.previousSessionType), dateA: fmt.sht(i.previousSessionDate || ""),
        b: typeLabel(i.sessionType), dateB: fmt.sht(i.sessionDate || ""),
      });
      case "TAPER_INTERVALS": return t("plan.editor.warn.taperIntervals", { count: days });
      case "TAPER_TEMPO": return t("plan.editor.warn.taperTempo", { count: days });
      case "TAPER_VOLUME": return t("plan.editor.warn.taperVolume", { week: i.weekNumber });
      case "SAME_DAY": return t("plan.editor.warn.sameDay", { date: fmt.sht(s?.date || "") });
      case "RACE_ADJACENT": return t("plan.editor.warn.raceAdjacent");
      default: return t("plan.editor.warn.generic");
    }
  };

  const warningBox = (list: PlanIssue[]) => list.length > 0 && (
    <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2.5 space-y-1.5" role="status">
      <p className="flex items-center gap-1.5 text-xs font-bold text-amber-300">
        <AlertTriangle size={13}/>{t("plan.editor.headsUp")}
      </p>
      {list.map((i, n) => <p key={n} className="text-xs text-amber-100/90 leading-snug">{issueText(i)}</p>)}
      <p className="text-[11px] text-slate-400 leading-snug">
        {t("plan.editor.yourCall")}{" "}
        <button onClick={onAskCoach} className="font-semibold text-orange-300 underline underline-offset-2">{t("plan.editor.askCoach")}</button>
      </p>
    </div>
  );

  const chip = (on: boolean) => "rounded-lg border text-xs font-semibold transition-colors disabled:opacity-30 " +
    (on ? "border-orange-500 bg-orange-500/15 text-orange-200" : "border-slate-600 text-slate-300 hover:bg-slate-700");

  const weekDays = viewWeek?.startDate ? Array.from({ length: 7 }, (_, i) => addDays(viewWeek.startDate!, i)) : [];
  const typeChoices = (EDIT_TYPES as readonly string[]).includes(initType) ? EDIT_TYPES : [...EDIT_TYPES, initType];

  return (
    <div className="fixed inset-0 bg-black/70 z-[2000] flex items-end animate-overlay-fade" onClick={onClose}>
      <div
        className="w-full max-w-lg mx-auto bg-slate-800 border-t border-slate-700 rounded-t-2xl p-4 space-y-4 animate-slide-up max-h-[90vh] overflow-y-auto"
        style={{ paddingBottom: "calc(1.5rem + var(--safe-bottom))" }}
        onClick={e => e.stopPropagation()}
      >
        <div className="w-9 h-1 rounded-full bg-slate-600 mx-auto -mb-1"/>
        <div>
          <h3 className="text-base font-bold text-white">{t(orig ? "plan.editor.editTitle" : "plan.editor.addTitle")}</h3>
          {orig && <p className="text-xs text-slate-400 mt-0.5">{describeSession(orig) + " · " + fmt.sht(orig.date)}</p>}
        </div>

        {confirmDelete ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-200">{t("plan.editor.deleteConfirm")}</p>
            <p className="text-xs text-slate-400">{t("plan.editor.deleteHint")}</p>
            {warningBox(delIssues)}
            <ConfirmButtons onCancel={() => setConfirmDelete(false)} cancelLabel={t("common.cancel")}
              onAccept={() => delNext && onSave({ kind: "delete", sessionId: orig!.id }, delIssues.length)}
              acceptLabel={t("common.delete")}/>
          </div>
        ) : (
          <>
            {/* Day */}
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-xs text-slate-400 flex-1">{t("plan.editor.day")}</span>
                <button onClick={() => stepWeek(-1)} disabled={!weekHasRoom(-1)} aria-label={t("plan.editor.prevWeek")}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-300 hover:bg-slate-700 disabled:opacity-30">
                  <ChevronLeft size={15}/>
                </button>
                <span className="text-xs font-semibold text-slate-200 min-w-[7rem] text-center">
                  {viewWeek ? t("plan.week.label", { number: viewWeek.weekNumber }) + " · " + fmt.sht(viewWeek.startDate || "") : ""}
                </span>
                <button onClick={() => stepWeek(1)} disabled={!weekHasRoom(1)} aria-label={t("plan.editor.nextWeek")}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-300 hover:bg-slate-700 disabled:opacity-30">
                  <ChevronRight size={15}/>
                </button>
              </div>
              <div className="grid grid-cols-7 gap-1">
                {weekDays.map(d => {
                  const on = d === date;
                  const busy = (viewWeek?.sessions || []).filter(s => s.date === d && s.id !== orig?.id && !s.skipped);
                  return (
                    <button key={d} onClick={() => setDate(d)} disabled={!on && !canPlaceOn(plan, d, today)}
                      aria-pressed={on} aria-label={dayName(weekday(d)) + " " + fmt.sht(d)}
                      className={chip(on) + " py-1.5 flex flex-col items-center gap-0.5"}>
                      <span className="text-[10px] uppercase">{dayName(weekday(d))}</span>
                      <span>{Number(d.slice(8))}</span>
                      <span className={"w-1.5 h-1.5 rounded-full " + (busy[0] ? "bg-current " + typeClass(String(busy[0].type)) : "")}/>
                    </button>
                  );
                })}
              </div>
              {swapCand && (
                <label className="flex items-center gap-3 mt-2 cursor-pointer">
                  <input type="checkbox" checked={swap} onChange={e => setSwap(e.target.checked)}
                    className="w-4 h-4 accent-orange-500 flex-shrink-0"/>
                  <span className="text-xs text-slate-300 leading-snug">
                    {t("plan.editor.swap", { type: typeLabel(String(swapCand.type)), date: fmt.sht(orig!.date) })}
                  </span>
                </label>
              )}
            </div>

            {/* Type */}
            <div>
              <span className="block text-xs text-slate-400 mb-1.5">{t("plan.editor.type")}</span>
              <div className="flex flex-wrap gap-1.5">
                {typeChoices.map(ty => (
                  <button key={ty} onClick={() => pickType(ty)} aria-pressed={type === ty}
                    className={chip(type === ty) + " px-3 py-1.5"}>
                    <span className={type === ty ? "" : typeClass(ty)}>{typeLabel(ty)}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Distance */}
            <div>
              <label htmlFor="sess-km" className="block text-xs text-slate-400 mb-1.5">{t("plan.editor.distance")}</label>
              <div className="flex items-center gap-2">
                <button onClick={() => setKm((kmValid ? km : MIN_KM) - 0.5)} aria-label={t("plan.editor.shorter")}
                  className="w-10 h-10 rounded-xl border border-slate-600 flex items-center justify-center text-slate-200 hover:bg-slate-700">
                  <Minus size={16}/>
                </button>
                <input id="sess-km" inputMode="decimal" value={kmStr} onChange={e => setKmStr(e.target.value)}
                  className="w-20 bg-slate-700 border border-slate-600 rounded-xl py-2 text-center text-white text-sm focus:outline-none focus:border-orange-400"/>
                <span className="text-sm text-slate-400">km</span>
                <button onClick={() => setKm((kmValid ? km : MIN_KM) + 0.5)} aria-label={t("plan.editor.longer")}
                  className="w-10 h-10 rounded-xl border border-slate-600 flex items-center justify-center text-slate-200 hover:bg-slate-700">
                  <Plus size={16}/>
                </button>
              </div>
              {!kmValid && kmStr !== "" && (
                <p className="text-xs text-amber-300 mt-1">{t("plan.editor.kmRange", { min: MIN_KM, max: MAX_KM })}</p>
              )}
            </div>

            {warningBox(issues.warnings)}

            <div className="grid grid-cols-2 gap-2 pt-1">
              <button onClick={onClose}
                className="py-2.5 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200">
                {t("common.cancel")}
              </button>
              <button onClick={() => canSave && onSave(edit, issues.warnings.length)} disabled={!canSave}
                className="py-2.5 rounded-xl text-sm font-semibold bg-orange-500 hover:bg-orange-600 disabled:opacity-40 disabled:hover:bg-orange-500 text-white">
                {t(issues.warnings.length ? "plan.editor.saveAnyway" : orig ? "plan.editor.save" : "plan.editor.add")}
              </button>
            </div>

            {orig && (
              <button onClick={() => setConfirmDelete(true)}
                className="w-full flex items-center justify-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-red-300 py-1">
                <Trash2 size={13}/>{t("plan.editor.delete")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
