import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { StretchFigure } from "../components/StretchFigure";
import { useDismissable } from "../hooks/useDismissable";
import { MOVE_KIND, itemTime } from "../stretch/routines";
import type { RoutineItem } from "../stretch/routines";
import type { StretchSide } from "../utils/stretchEngine";

type StretchMovePreviewProps = {
  items: RoutineItem[];
  start: number;
  onClose: () => void;
};

/** One move of a routine up close, before starting: the figure, the cues, and the other side. */
export function StretchMovePreview({ items, start, onClose }: StretchMovePreviewProps) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(start);
  const [side, setSide] = useState<StretchSide>("left");
  useDismissable(true, onClose);
  const item = items[index];
  const go = (i: number) => { setIndex(i); setSide("left"); };
  const name = t(`stretch.moves.${item.move}.name`);

  return (
    <div className="fixed inset-0 bg-slate-900 z-[55] flex flex-col animate-slide-up">
      <header className="flex items-center gap-2 px-3 border-b border-slate-800 shrink-0"
        style={{ height: "calc(48px + var(--safe-top))", paddingTop: "var(--safe-top)" }}>
        <span className="w-8"/>
        <span className="flex-1 text-center text-xs text-slate-400 tabular-nums">
          {t("stretch.player.progress", { n: index + 1, total: items.length })}
        </span>
        <button onClick={onClose} aria-label={t("common.close")} className="text-slate-400 hover:text-white p-1.5">
          <X size={20}/>
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-lg mx-auto p-4 space-y-4">
          <div className="bg-slate-800 rounded-2xl flex items-center justify-center" style={{ height: "min(45vh, 340px)" }}>
            <StretchFigure move={item.move} side={item.sides === 2 ? side : null} animate bg="#1e293b"
              className="h-full max-h-full aspect-square" label={name}/>
          </div>

          {item.sides === 2 && (
            <div className="grid grid-cols-2 gap-1 bg-slate-800 rounded-xl p-1" role="group">
              {(["left", "right"] as const).map(s => (
                <button key={s} onClick={() => setSide(s)} aria-pressed={side === s}
                  className={"py-1.5 rounded-lg text-xs font-semibold transition-colors " + (side === s
                    ? "text-teal-200 bg-teal-400/15"
                    : "text-slate-400 hover:text-slate-200")}>
                  {t(s === "left" ? "stretch.player.left" : "stretch.player.right")}
                </button>
              ))}
            </div>
          )}

          <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-xl font-bold leading-tight">{name}</h2>
              <span className="text-sm text-teal-300 font-semibold shrink-0 tabular-nums">{itemTime(t, item)}</span>
            </div>
            <p className="text-sm text-slate-400">
              {t(`stretch.moves.${item.move}.target`)} · {t(MOVE_KIND[item.move] === "drill" ? "stretch.preview.drill" : "stretch.preview.hold")}
            </p>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">{t("stretch.preview.how")}</p>
            <ul className="space-y-2">
              {[1, 2, 3].map(n => (
                <li key={n} className="flex gap-2.5 text-sm text-slate-200 leading-snug">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-teal-400 shrink-0" aria-hidden/>
                  {t(`stretch.moves.${item.move}.cue${n}`)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="shrink-0 px-4 pt-2 border-t border-slate-800" style={{ paddingBottom: "calc(1rem + var(--safe-bottom))" }}>
        <div className="max-w-lg mx-auto grid grid-cols-2 gap-2">
          <button onClick={() => go(index - 1)} disabled={index === 0}
            className="flex items-center justify-center gap-1 py-2.5 rounded-xl text-sm font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40 disabled:hover:bg-slate-800">
            <ChevronLeft size={16}/>{t("stretch.player.previous")}
          </button>
          <button onClick={() => go(index + 1)} disabled={index === items.length - 1}
            className="flex items-center justify-center gap-1 py-2.5 rounded-xl text-sm font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40 disabled:hover:bg-slate-800">
            {t("stretch.preview.next")}<ChevronRight size={16}/>
          </button>
        </div>
      </div>
    </div>
  );
}
