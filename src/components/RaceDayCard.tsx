import { useTranslation } from "react-i18next";
import { Check, ChevronRight, Play, Radio } from "lucide-react";
import { LIVE_SHARE_KEY } from "../constants";
import { fmt } from "../utils/format";
import { daysUntil } from "../utils/raceDay";
import { useShareLink } from "../hooks/useShareLink";
import { ShareLinkPanel } from "./ShareLinkPanel";
import type { Participation } from "../types";

type RaceDayCardProps = {
  race: Participation | null;
  today: string;
  linkSent: boolean;
  testDone: boolean;
  onLinkSent: () => void;
  onStart: () => void;
  showToast: (msg: string, type?: string) => void;
};

const readShareOn = () => {
  try { return localStorage.getItem(LIVE_SHARE_KEY) === "1"; } catch { return false; }
};

// Home for a runner who came to be followed live (docs/live-sharing.md):
// the race countdown, the link, a test run, and one button to start.
export function RaceDayCard({ race, today, linkSent, testDone, onLinkSent, onStart, showToast }: RaceDayCardProps) {
  const { t } = useTranslation();
  const link = useShareLink(showToast);
  const shareOn = readShareOn();
  const days = race?.raceDate ? daysUntil(race.raceDate, today) : null;
  const raceToday = days === 0;

  return (
    <div className="rounded-2xl p-4 border border-orange-500/30 space-y-4"
      style={{background:"linear-gradient(135deg,rgba(249,115,22,.13),rgba(16,185,129,.08))"}}>
      {race ? (
        <div className="flex justify-between items-start gap-3">
          <div className="min-w-0">
            <p className="text-orange-300 text-xs font-semibold uppercase tracking-widest mb-1">{t("raceDay.card.eyebrow")}</p>
            <p className="font-semibold truncate">{race.label}</p>
            <p className="text-slate-400 text-sm mt-0.5">{fmt.date(race.raceDate as string) + (race.distanceKm ? " · " + race.distanceKm + " km" : "")}</p>
          </div>
          <div className="text-right shrink-0">
            {raceToday ? (
              <p className="text-2xl font-black text-orange-400 leading-none">{t("raceDay.card.today")}</p>
            ) : (
              <>
                <p className="text-5xl font-black text-orange-400 leading-none">{days}</p>
                <p className="text-slate-400 text-xs mt-1">{t("dashboard.race.daysToGo")}</p>
              </>
            )}
          </div>
        </div>
      ) : (
        <div>
          <p className="text-emerald-300 text-xs font-semibold uppercase tracking-widest mb-1">{t("raceDay.card.liveEyebrow")}</p>
          <p className="font-semibold">{t("raceDay.card.liveTitle")}</p>
          <p className="text-slate-400 text-sm mt-0.5">{t("raceDay.card.liveSub")}</p>
        </div>
      )}

      <div className="space-y-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
          {linkSent && <Check size={13} className="text-emerald-400"/>}
          {t(linkSent ? "raceDay.card.linkSent" : "raceDay.card.linkTodo")}
        </p>
        <ShareLinkPanel link={link} active={shareOn} onSent={onLinkSent}/>
      </div>

      {!testDone && (
        <div className="flex items-center gap-3 rounded-xl bg-slate-900/50 p-3">
          <span className="w-5 h-5 rounded-full border-2 border-dashed border-amber-400/70 shrink-0" aria-hidden/>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-slate-200">{t("raceDay.card.testTitle")}</p>
            <p className="text-xs text-slate-400">{t("raceDay.card.testSub")}</p>
          </div>
          <button onClick={onStart}
            className="shrink-0 text-xs font-semibold text-orange-200 bg-orange-500/15 hover:bg-orange-500/25 rounded-lg px-3 py-1.5 transition-colors">
            {t("raceDay.card.testCta")}
          </button>
        </div>
      )}

      {!shareOn && <p className="text-xs text-amber-300/90">{t("raceDay.card.shareOff")}</p>}

      <button onClick={onStart}
        className={"w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold text-white transition-colors "
          + (shareOn ? "bg-emerald-600 hover:bg-emerald-500" : "bg-orange-500 hover:bg-orange-600")}>
        {shareOn ? <Radio size={16}/> : <Play size={16}/>}
        {t(raceToday ? "raceDay.card.startRace" : "raceDay.card.startRun") + (shareOn ? " · " + t("raceDay.card.sharedLive") : "")}
      </button>
    </div>
  );
}

// The plan offer in race-day mode: a quiet row, never the headline.
export function RaceDayPlanRow({ upcoming, onClick }: { upcoming: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button onClick={onClick}
      className="w-full bg-slate-800 rounded-xl p-3.5 flex items-center gap-3 text-left hover:bg-slate-700/70 transition-colors">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold">{t(upcoming ? "raceDay.plan.beforeTitle" : "raceDay.plan.afterTitle")}</p>
        <p className="text-xs text-slate-400">{t(upcoming ? "raceDay.plan.beforeSub" : "raceDay.plan.afterSub")}</p>
      </div>
      <ChevronRight size={16} className="text-slate-600 flex-shrink-0"/>
    </button>
  );
}
