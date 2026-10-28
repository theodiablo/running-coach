import { useTranslation } from "react-i18next";
import { Flag, HeartPulse, Target } from "lucide-react";
import { fmt } from "../utils/format";
import type { PhaseInfo } from "../utils/planPhase";

// After the race: the Home slot the race countdown held. Asks how it went, then
// (once settled) how it felt, then points at what's next. The forgiving stance
// of overdue.ts applies: a slow result is amber, never red, and nothing here
// counts as a miss. docs/training-plan.md.

// "How did it feel?" answers, on the run's existing 1-10 effort field.
const FEEL_CHIPS = [["easy", 4], ["hard", 6], ["veryHard", 8], ["allOut", 10]] as const;

const CARD = "rounded-2xl p-5 border ";
const BTN = "flex-1 min-w-[40%] py-2.5 px-3 rounded-xl text-sm font-semibold transition-colors ";

type DebriefCardProps = {
  info: PhaseInfo;
  // The catalogue name of the race, null for a hand-entered one (neutral copy).
  label: string | null;
  // settings.goalSec as a number; 0 when the runner never set one.
  goalSec: number;
  onRan: () => void;
  onDidntRun: () => void;
  onMoved: () => void;
  onFeel: (effort: number) => void;
};

export function DebriefCard({ info, label, goalSec, onRan, onDidntRun, onMoved, onFeel }: DebriefCardProps) {
  const { t } = useTranslation();

  if (info.debrief === "result") {
    const sec = info.resultSec;
    const line = !sec ? null
      : !goalSec ? { cls: "text-slate-300", text: t("dashboard.debrief.noGoal", { time: fmt.dur(sec) }) }
      : sec <= goalSec ? { cls: "text-emerald-300", text: t("dashboard.debrief.underGoal", { time: fmt.dur(sec), goal: fmt.dur(goalSec) }) }
      : { cls: "text-amber-300", text: t("dashboard.debrief.overGoal", { time: fmt.dur(sec), goal: fmt.dur(goalSec) }) };
    return (
      <div className={CARD + "border-emerald-500/30 bg-emerald-500/5"}>
        <p className="text-emerald-300 text-xs font-semibold uppercase tracking-widest mb-1">{t("dashboard.debrief.result")}</p>
        {line && <p className={"font-semibold " + line.cls}>{line.text}</p>}
        <p className="text-slate-400 text-sm mt-3">{t("dashboard.debrief.feelTitle")}</p>
        <div className="flex flex-wrap gap-2 mt-2">
          {FEEL_CHIPS.map(([key, effort]) => (
            <button key={key} onClick={() => onFeel(effort)}
              className={BTN + "bg-slate-700 hover:bg-slate-600 text-slate-100"}>
              {t("dashboard.debrief.feel." + key)}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Ask. A hand-entered race has no edition to name, so the question is plainer
  // and has no "moved" (the Plan tab is where its date lives).
  return (
    <div className={CARD + "border-orange-500/30"}
      style={{ background: "linear-gradient(135deg,rgba(249,115,22,.13),rgba(220,38,38,.13))" }}>
      <p className="text-orange-300 text-xs font-semibold uppercase tracking-widest mb-1">{t("dashboard.race.title")}</p>
      <p className="font-semibold">
        {label ? t("dashboard.debrief.askTitle", { label }) : t("dashboard.debrief.neutralTitle", { date: fmt.date(info.race.date) })}
      </p>
      <div className="flex flex-wrap gap-2 mt-3">
        <button onClick={onRan} className={BTN + "bg-orange-500 hover:bg-orange-600 text-white"}>
          {t(label ? "dashboard.debrief.ranIt" : "dashboard.debrief.neutralYes")}
        </button>
        <button onClick={onDidntRun} className={BTN + "bg-slate-700 hover:bg-slate-600 text-slate-200"}>
          {t(label ? "dashboard.debrief.didntRun" : "dashboard.debrief.neutralNo")}
        </button>
        {label && (
          <button onClick={onMoved} className={BTN + "bg-slate-700/60 hover:bg-slate-600 text-slate-300"}>
            {t("dashboard.debrief.moved")}
          </button>
        )}
      </div>
    </div>
  );
}

// The settled race's way forward: never a dead end, never urgent.
export function NextGoalCard({ onSetGoal, onBrowse }: { onSetGoal: () => void; onBrowse: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={CARD + "border-orange-500/30"}
      style={{ background: "linear-gradient(135deg,rgba(249,115,22,.13),rgba(220,38,38,.13))" }}>
      <p className="text-orange-300 text-xs font-semibold uppercase tracking-widest mb-1">{t("dashboard.next.title")}</p>
      <p className="text-slate-300 text-sm">{t("dashboard.next.subtitle")}</p>
      <button onClick={onSetGoal}
        className="w-full mt-3 flex items-center justify-center gap-1.5 bg-orange-500 hover:bg-orange-600 text-white py-2.5 rounded-xl text-sm font-semibold transition-colors">
        <Target size={15}/>{t("plan.next.cta")}
      </button>
      <button onClick={onBrowse}
        className="w-full mt-2 flex items-center justify-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors py-1.5">
        <Flag size={13}/>{t("dashboard.next.races")}
      </button>
    </div>
  );
}

// The race is done and the plan was written with a recovery after it: easy days
// until a date, nothing to answer. The next-session card below stays as normal.
export function RecoveryCard({ info }: { info: PhaseInfo }) {
  const { t } = useTranslation();
  const rec = info.recovery;
  if (!rec) return null;
  return (
    <div className={CARD + "border-emerald-500/30 bg-emerald-500/5"}>
      <p className="text-emerald-300 text-xs font-semibold uppercase tracking-widest mb-1">{t("dashboard.recoveryCard.title")}</p>
      <p className="font-semibold">{t("dashboard.recoveryCard.headline", { date: fmt.date(rec.until) })}</p>
      <p className="text-slate-400 text-sm mt-1">
        {rec.daysLeft > 0 ? t("dashboard.recoveryCard.sub", { count: rec.daysLeft }) : t("dashboard.recoveryCard.lastDay")}
      </p>
    </div>
  );
}

// Offered for as long as a recovery is running, debrief included.
export function SoreRow({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <button onClick={onOpen}
      className="w-full -mt-2 flex items-center justify-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors py-1.5">
      <HeartPulse size={13}/>{t("dashboard.sore.row")}
    </button>
  );
}
