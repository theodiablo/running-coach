import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { StretchFigure } from "../components/StretchFigure";
import { StretchInfo } from "../components/StretchInfo";
import { useDismissable } from "../hooks/useDismissable";
import { ROUTINES, ROUTINE_ORDER, cooldownFor, itemTime } from "../stretch/routines";
import type { Routine, RoutineId, RoutineItem } from "../stretch/routines";
import type { StretchSuggestion } from "../utils/stretchSuggest";
import { routineMinutes } from "../utils/stretchEngine";
import { StretchPlayer } from "./StretchPlayer";
import { StretchMovePreview } from "./StretchMovePreview";

/** What opened the sheet: a Home suggestion goes straight to its routine. */
export type StretchTarget = StretchSuggestion;

type StretchSheetProps = {
  target: StretchTarget | null;
  weekCount: number;
  voice: boolean;
  onVoiceChange: (on: boolean) => void;
  onComplete: (routine: RoutineId, sec: number) => void;
  onClose: () => void;
};

const routineFor = (target: StretchTarget): Routine =>
  target.routine === "cooldown" ? cooldownFor(target.focus) : ROUTINES.recovery;

function WeekLine({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 text-xs text-slate-400">
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map(i => <span key={i} className={"w-2 h-2 rounded-full " + (i < count ? "bg-teal-400" : "bg-slate-700")}/>)}
      </span>
      <span>{count > 0 ? t("stretch.sheet.week", { count }) : t("stretch.sheet.weekNone")} · {t("stretch.sheet.weekAim")}</span>
    </div>
  );
}

function ItemRow({ item, onOpen }: { item: RoutineItem; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <li>
      <button onClick={onOpen} className="w-full flex items-center gap-3 py-1.5 text-left group">
        <StretchFigure move={item.move} crop bg="#0f172a" className="w-11 h-11 rounded-lg bg-slate-900 shrink-0"/>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold leading-snug group-hover:text-orange-300 transition-colors">{t(`stretch.moves.${item.move}.name`)}</span>
          <span className="block text-xs text-slate-400">{t(`stretch.moves.${item.move}.target`)}</span>
        </span>
        <span className="text-xs text-slate-300 tabular-nums shrink-0">{itemTime(t, item)}</span>
        <ChevronRight size={14} className="text-slate-600 shrink-0"/>
      </button>
    </li>
  );
}

// The stretching flow: the routine list, one routine's preview, and the player
// on top. Lazily loaded, premium only for now (docs/stretching.md).
export function StretchSheet({ target, weekCount, voice, onVoiceChange, onComplete, onClose }: StretchSheetProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Routine | null>(() => (target ? routineFor(target) : null));
  const [viaTarget, setViaTarget] = useState(!!target);
  const [playing, setPlaying] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const previewItems = selected ? [...selected.items, ...(selected.tail ?? [])] : [];
  const canGoBack = !!selected && !viaTarget;
  const showList = () => { setSelected(null); setViaTarget(false); };
  useDismissable(true, () => (canGoBack ? setSelected(null) : onClose()));

  const why = (() => {
    if (!target || !viaTarget) return null;
    const km = target.km.toFixed(1);
    if (target.routine === "recovery") return t("stretch.sheet.whyRecovery");
    if (target.focus === "hills") return t("stretch.sheet.whyCooldownHills", { km });
    if (target.focus === "hard") return t("stretch.sheet.whyCooldownHard", { km });
    return t("stretch.sheet.whyCooldown", { km });
  })();


  return (
    <div className="fixed inset-0 bg-slate-900 z-50 flex flex-col animate-slide-up">
      <header className="flex items-center gap-2 px-3 border-b border-slate-800 shrink-0"
        style={{ height: "calc(48px + var(--safe-top))", paddingTop: "var(--safe-top)" }}>
        {canGoBack ? (
          <button onClick={() => setSelected(null)} aria-label={t("stretch.sheet.allRoutines")} className="text-slate-400 hover:text-white p-1.5">
            <ChevronLeft size={20}/>
          </button>
        ) : <span className="w-8"/>}
        <span className="flex-1 text-center text-sm font-semibold">{t("stretch.sheet.title")}</span>
        <button onClick={onClose} aria-label={t("common.close")} className="text-slate-400 hover:text-white p-1.5">
          <X size={20}/>
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-lg mx-auto p-4 space-y-4" style={selected ? undefined : { paddingBottom: "calc(1rem + var(--safe-bottom))" }}>
          {selected ? (
            <>
              <div className="space-y-1">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-xl font-bold">{t(`stretch.routines.${selected.id}.name`)}</h2>
                  <span className="text-sm text-teal-300 font-semibold shrink-0">{t("stretch.sheet.minutes", { count: routineMinutes(selected) })}</span>
                </div>
                <p className="text-sm text-slate-400">{t(`stretch.routines.${selected.id}.when`)}</p>
              </div>
              {why && <p className="text-sm text-slate-300 bg-slate-800 rounded-xl px-3 py-2.5">{why}</p>}
              <div>
                <p className="text-xs text-slate-500 mb-1">{t("stretch.sheet.tapToPreview")}</p>
                {(selected.rounds ?? 1) > 1 && (
                  <p className="text-xs text-slate-400 mb-1">{t("stretch.sheet.rounds", { count: selected.rounds })}</p>
                )}
                <ul className="divide-y divide-slate-800">
                  {selected.items.map((item, i) => <ItemRow key={item.move + item.sec} item={item} onOpen={() => setPreview(i)}/>)}
                </ul>
                {selected.tail?.length ? (
                  <>
                    <p className="text-xs text-slate-400 mt-2 mb-1">{t("stretch.sheet.then")}</p>
                    <ul className="divide-y divide-slate-800">
                      {selected.tail.map((item, i) => <ItemRow key={item.move + item.sec} item={item} onOpen={() => setPreview(selected.items.length + i)}/>)}
                    </ul>
                  </>
                ) : null}
              </div>
              <p className="text-xs text-slate-500">{t(`stretch.routines.${selected.id}.why`)}</p>
              <WeekLine count={weekCount}/>
              <p className="text-xs text-amber-200/80">{t("stretch.sheet.safety")}</p>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-400">{t("stretch.sheet.subtitle")}</p>
              <div className="space-y-2.5">
                {ROUTINE_ORDER.map(id => {
                  const r = ROUTINES[id];
                  return (
                    <button key={id} onClick={() => setSelected(r)}
                      className="w-full flex items-center gap-3 bg-slate-800 hover:bg-slate-700/70 rounded-2xl p-3.5 text-left transition-colors">
                      <StretchFigure move={r.items[0].move} crop bg="#0f172a" className="w-12 h-12 rounded-xl bg-slate-900 shrink-0"/>
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-semibold">{t(`stretch.routines.${id}.name`)}</span>
                        <span className="block text-xs text-slate-400">{t(`stretch.routines.${id}.when`)}</span>
                      </span>
                      <span className="text-xs text-teal-300 font-semibold shrink-0">{t("stretch.sheet.minutes", { count: routineMinutes(r) })}</span>
                      <ChevronRight size={16} className="text-slate-500 shrink-0"/>
                    </button>
                  );
                })}
              </div>
              <WeekLine count={weekCount}/>
            </>
          )}
          <div className="flex items-center gap-5">
            {viaTarget && selected && (
              <button onClick={showList} className="text-xs text-slate-400 hover:text-orange-400 transition-colors">
                {t("stretch.sheet.allRoutines")}
              </button>
            )}
            <StretchInfo/>
          </div>
        </div>
      </div>

      {selected && (
        <div className="shrink-0 px-4 pt-2 border-t border-slate-800" style={{ paddingBottom: "calc(1rem + var(--safe-bottom))" }}>
          <button onClick={() => setPlaying(true)}
            className="w-full max-w-lg mx-auto block bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-xl py-3">
            {t("stretch.sheet.start")}
          </button>
        </div>
      )}

      {preview !== null && selected && (
        <StretchMovePreview items={previewItems} start={preview} onClose={() => setPreview(null)}/>
      )}

      {playing && selected && (
        <StretchPlayer routine={selected} voice={voice} onVoiceChange={onVoiceChange} weekCount={weekCount}
          onComplete={sec => onComplete(selected.id, sec)} onClose={() => setPlaying(false)} onFinish={onClose}/>
      )}
    </div>
  );
}
