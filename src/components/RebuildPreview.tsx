import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { TCLR } from "../constants";
import { fmt } from "../utils/format";
import { useDismissable } from "../hooks/useDismissable";
import type { PlanDiff, SessionChange, WeekDiff } from "../utils/planDiff";
import type { PlanSession, RunType } from "../types";

type RebuildPreviewProps = {
  diff: PlanDiff;
  raceDate: string;
  onApply: () => void;
  onBack: () => void;
  onKeep: () => void;
};

const typeClass = (type: PlanSession["type"]) => TCLR[type as RunType] || TCLR.OTHER;
const km1 = (n: number) => n.toFixed(1);

// Unchanged weeks between two changed ones collapse into one "no change" row.
type Block = { kind: "week"; week: WeekDiff } | { kind: "same"; from: string; to: string };
const blocks = (weeks: WeekDiff[]): Block[] => {
  const out: Block[] = [];
  for (const week of weeks) {
    const last = out[out.length - 1];
    if (week.changes.length) out.push({ kind: "week", week });
    else if (last?.kind === "same") last.to = week.start;
    else out.push({ kind: "same", from: week.start, to: week.start });
  }
  return out;
};

export function RebuildPreview({ diff, raceDate, onApply, onBack, onKeep }: RebuildPreviewProps) {
  const { t } = useTranslation();
  useDismissable(true, onBack);
  const typeLabel = (s: PlanSession) => t("common.types." + s.type, { defaultValue: s.type });

  const row = (c: SessionChange, i: number) => {
    const { before: b, after: a } = c;
    const tag = !b ? t("plan.preview.added") : !a ? t("plan.preview.removed") : null;
    const cur = a ?? b!;
    const typeChanged = !!(a && b && a.type !== b.type);
    const kmChanged = !!(a && b && Number(a.km) !== Number(b.km));
    return (
      <li key={c.date + i} className="flex items-start gap-2 bg-orange-500/5 rounded-lg px-2 py-1.5 -mx-2">
        <span className="w-14 flex-shrink-0 text-xs text-slate-500 pt-0.5">{fmt.sht(c.date)}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5 flex-wrap">
            {typeChanged && <span className="text-xs font-bold uppercase line-through text-slate-500">{typeLabel(b!)}</span>}
            <span className={"text-xs font-bold uppercase " + (a ? typeClass(cur.type) : "line-through text-slate-500")}>{typeLabel(cur)}</span>
            {tag && <span className={"text-[10px] font-semibold uppercase tracking-wide rounded px-1 " + (a ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-700 text-slate-400")}>{tag}</span>}
          </div>
          {a && b && !typeChanged && !kmChanged && <p className="text-xs text-slate-400 mt-0.5">{a.desc}</p>}
        </div>
        <span className="text-sm tabular-nums flex-shrink-0 flex items-baseline gap-1.5">
          {kmChanged && <span className="text-xs text-slate-500 line-through">{km1(Number(b!.km))}</span>}
          <span className={a ? "text-slate-200" : "text-slate-500 line-through"}>{km1(Number(cur.km))} km</span>
        </span>
      </li>
    );
  };

  const chip = (cls: string, text: string) => <span className={"text-xs rounded-full px-2.5 py-1 " + cls}>{text}</span>;
  const changed = diff.changed > 0;

  return (
    <div className="p-4 max-w-lg mx-auto">
      <div className="flex items-center gap-2.5 mt-4 mb-1">
        <button onClick={onBack} aria-label={t("common.back")}
          className="w-[34px] h-[34px] rounded-lg bg-slate-700 flex items-center justify-center text-slate-300 hover:bg-slate-600 transition-colors flex-shrink-0">
          <ArrowLeft size={18}/>
        </button>
        <h2 className="text-lg font-bold">{t("plan.preview.title")}</h2>
      </div>
      <p className="text-xs text-slate-500 mb-3">{t("plan.preview.intro")}</p>

      <div className="flex flex-wrap gap-1.5 mb-4">
        {changed
          ? chip("bg-amber-500/10 text-amber-300", t("plan.preview.changed", { count: diff.changed }))
          : chip("bg-emerald-500/10 text-emerald-300", t("plan.preview.noChanges"))}
        {diff.raceDateMoved
          ? chip("bg-amber-500/10 text-amber-300", t("plan.preview.raceMoved", { date: fmt.sht(raceDate) }))
          : chip("bg-emerald-500/10 text-emerald-300", t("plan.preview.raceSame"))}
        {diff.keptDone > 0 && chip("bg-slate-800 text-slate-300", t("plan.preview.kept", { count: diff.keptDone }))}
      </div>

      <div className="space-y-2">
        {blocks(diff.weeks).map(bl => bl.kind === "same" ? (
          <div key={"same" + bl.from} className="bg-slate-800/60 rounded-xl px-3 py-2.5 flex justify-between text-xs text-slate-400">
            <span>{bl.from === bl.to
              ? t("plan.preview.weekOf", { date: fmt.sht(bl.from) })
              : t("plan.preview.range", { from: fmt.sht(bl.from), to: fmt.sht(bl.to) })}</span>
            <span>{t("plan.preview.noChange")}</span>
          </div>
        ) : (
          <div key={bl.week.start} className="bg-slate-800 rounded-xl p-3">
            <div className="flex justify-between text-xs mb-1.5">
              <span className="font-semibold text-slate-200">{t("plan.preview.weekOf", { date: fmt.sht(bl.week.start) })}</span>
              <span className="text-slate-400 tabular-nums">
                {km1(bl.week.kmBefore) !== km1(bl.week.kmAfter) && <><span className="line-through text-slate-500">{km1(bl.week.kmBefore)}</span> → </>}
                {km1(bl.week.kmAfter)} km
              </span>
            </div>
            <ul className="space-y-1">{bl.week.changes.map(row)}</ul>
          </div>
        ))}
      </div>

      <button onClick={onApply}
        className="w-full mt-5 bg-orange-500 hover:bg-orange-600 text-white py-3 rounded-xl font-semibold transition-colors">
        {changed ? t("plan.preview.apply") : t("plan.preview.applySettings")}
      </button>
      <button onClick={onKeep}
        className="w-full mt-2 border border-slate-600 hover:bg-slate-800 text-slate-200 py-2.5 rounded-xl font-semibold transition-colors">
        {t("plan.preview.keep")}
      </button>
    </div>
  );
}
