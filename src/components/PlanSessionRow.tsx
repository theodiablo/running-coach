import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, MessageCircle, MoreHorizontal, Play, RotateCcw, Route, SkipForward } from "lucide-react";
import { TCLR } from "../constants";
import { fmt, estMin } from "../utils/format";
import { describeSession } from "../utils/sessionDesc";
import { sessionSteps } from "../utils/sessionSteps";
import { useDismissable } from "../hooks/useDismissable";
import { HRTarget } from "./HRTarget";
import type { PlanSession, RunType, SettingsState } from "../types";

const typeClass = (type: PlanSession["type"]) => TCLR[(type as RunType) || "OTHER"] || "text-violet-400";

type PlanSessionRowProps = {
  session: PlanSession;
  settings: SettingsState;
  notesOpen: boolean;
  onToggleNotes: () => void;
  onRecord: () => void;
  onDone: () => void;
  onToggleDone: () => void;
  onSkip: () => void;
  onAskCoach: () => void;
  onFindRoute?: () => void;   // optional (route finder feature-gated); opens the finder for this distance
  openSettings: () => void;
};

// One plan session, with labeled actions. Replaces the old cramped icon row:
// "Record run" (start GPS) and "Done it" (log after the fact) are spelled out,
// and Skip is demoted into an overflow (⋯) menu so it no longer reads as delete.
export function PlanSessionRow({
  session: s, settings, notesOpen, onToggleNotes,
  onRecord, onDone, onToggleDone, onSkip, onAskCoach, onFindRoute, openSettings,
}: PlanSessionRowProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  useDismissable(menuOpen, () => setMenuOpen(false));

  const isSkipped = !!s.skipped && !s.done;
  const type = t("common.types." + s.type, { defaultValue: s.type });
  const title = describeSession(s);
  const meta = s.km + " km · ~" + estMin(Number(s.km), s.pace) + " · " + fmt.pace(s.pace) + "/km";

  // ── Done ──────────────────────────────────────────────────────────────────
  if (s.done) {
    return (
      <div className="rounded-xl bg-slate-800/60 px-4 py-3 opacity-75 flex items-start gap-3">
        <span className="w-5 h-5 rounded-full bg-emerald-500/15 border-[1.5px] border-emerald-400 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Check size={11} className="text-emerald-400"/>
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={"text-xs font-bold uppercase " + typeClass(s.type)}>{type}</span>
            <span className="text-xs text-slate-500">{fmt.sht(s.date)}</span>
          </div>
          <p className="text-sm font-semibold text-slate-400 line-through leading-snug mt-0.5">{title}</p>
        </div>
        <button onClick={onToggleDone}
          className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-700 transition-colors flex-shrink-0 self-center">
          <RotateCcw size={12}/>{t("common.undo")}
        </button>
      </div>
    );
  }

  // ── Skipped ───────────────────────────────────────────────────────────────
  if (isSkipped) {
    return (
      <div className="rounded-xl bg-slate-800/60 px-4 py-3 opacity-75 flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-400">
              {t("plan.session.skipped")}
            </span>
            <span className="text-xs text-slate-500">{fmt.sht(s.date)}</span>
          </div>
          <p className="text-sm font-semibold text-slate-500 line-through leading-snug mt-1">{title}</p>
          <p className="text-xs text-slate-500 mt-0.5">{t("plan.session.skippedReassure")}</p>
        </div>
        <button onClick={onSkip}
          className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-700 transition-colors flex-shrink-0 self-center">
          <RotateCcw size={12}/>{t("common.undo")}
        </button>
      </div>
    );
  }

  // ── To-do ─────────────────────────────────────────────────────────────────
  return (
    <div className="rounded-xl bg-slate-800 border border-slate-700/60">
      {/* Body — tap toggles the coach-notes breakdown */}
      <div className="px-4 py-3 cursor-pointer select-none" onClick={onToggleNotes}>
        <div className="flex items-center gap-2">
          <span className={"text-xs font-bold uppercase " + typeClass(s.type)}>{type}</span>
          <span className="text-xs text-slate-400 whitespace-nowrap">{fmt.sht(s.date)}</span>
          <span className="flex-1"/>
          <span className={"text-xs flex items-center gap-1 " + (notesOpen ? "text-orange-400" : "text-slate-500")}>
            <MessageCircle size={12}/>{t("plan.session.coachNotes")}
            <ChevronDown size={12} className={"transition-transform " + (notesOpen ? "rotate-180" : "")}/>
          </span>
        </div>
        <p className="text-sm font-semibold text-slate-100 leading-snug mt-1">{title}</p>
        <p className="text-xs text-slate-400 mt-0.5">{meta}</p>
        <HRTarget type={s.type} settings={settings} openSettings={openSettings}/>
        {notesOpen && (
          <div className="mt-2 rounded-lg bg-slate-900/70 px-3 py-2.5 space-y-1.5 animate-expand" onClick={e => e.stopPropagation()}>
            {sessionSteps(s).map(st => (
              <p key={st.label} className="text-xs text-slate-400 leading-relaxed">
                <span className="text-slate-300 font-semibold">{st.label}: </span>{st.detail}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Action footer */}
      <div className="relative flex items-center gap-2 px-4 py-2.5 border-t border-slate-700/50">
        <button onClick={onRecord}
          className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg bg-orange-500 text-slate-900 hover:bg-orange-400 transition-[background-color,transform] active:scale-95">
          <Play size={13}/>{t("plan.session.record")}
        </button>
        <button onClick={onDone}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 hover:bg-slate-700 transition-colors">
          <Check size={13}/>{t("plan.session.doneIt")}
        </button>
        <span className="flex-1"/>
        <button onClick={() => setMenuOpen(v => !v)}
          aria-label={t("plan.session.moreActions")} aria-expanded={menuOpen}
          className={"w-9 h-9 rounded-lg border flex items-center justify-center transition-colors " +
            (menuOpen ? "bg-slate-700 border-slate-600 text-slate-100" : "border-slate-600 text-slate-400 hover:bg-slate-700")}>
          <MoreHorizontal size={16}/>
        </button>

        {/* Invisible backdrop so a tap anywhere else closes the menu (Escape /
            Android back go through useDismissable; iOS and mouse users need this). */}
        {menuOpen && <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)}/>}
        {menuOpen && (
          <div
            className="absolute right-4 bottom-[calc(100%+6px)] z-20 w-56 rounded-xl bg-slate-800 border border-slate-600 shadow-2xl overflow-hidden animate-expand">
            <button onClick={() => { setMenuOpen(false); onAskCoach(); }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs font-semibold text-slate-200 hover:bg-slate-700 transition-colors border-b border-slate-700/60">
              <MessageCircle size={14} className="text-orange-400"/>{t("plan.session.askCoach")}
            </button>
            {onFindRoute && (
              <button onClick={() => { setMenuOpen(false); onFindRoute(); }}
                className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs font-semibold text-slate-200 hover:bg-slate-700 transition-colors border-b border-slate-700/60">
                <Route size={14} className="text-sky-400"/>{t("routeFinder.button")}
              </button>
            )}
            <button onClick={() => { setMenuOpen(false); onSkip(); }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs font-semibold text-slate-400 hover:bg-slate-700 transition-colors">
              <SkipForward size={14}/>{t("plan.session.skip")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
