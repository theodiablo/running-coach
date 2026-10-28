import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Flag, Gauge, Leaf, MapPin, Mountain, Sparkles, Target } from "lucide-react";
import { useDismissable } from "../hooks/useDismissable";
import { useNearMeFilter } from "../hooks/useNearMeFilter";
import { track } from "../telemetry";
import { findEdition, searchEditions } from "../utils/races";
import { fmt, ymd } from "../utils/format";
import { BlockRecap } from "../components/BlockRecap";
import type { BlockRecap as Recap } from "../utils/blockRecap";
import {
  FASTER_OPTIONS, FEELINGS, bestSecByKey, goalOrder, raceSuggestions, wishlistLead,
  type Feeling, type GoalOption, type WhatsNextVariant,
} from "../utils/whatsNext";
import type { OpenTarget, Participation, Run } from "../types";

// "What's next?": a recap of the block, how the runner feels, then the goals in
// the order that answer suggests. One screen, one job: it only collects an
// answer, the hub (RunningCoach.startNextGoal) acts on it. docs/races.md.

export type Promotable = { name: string; raceId?: string; edition: { id: string; date: string; distanceKm: number; elevation?: number } };

export type WhatsNextAnswer =
  | { choice: "later" }
  // null edition: nothing picked, browse the Races tab.
  | { choice: "race"; edition: Promotable | null }
  | { choice: "improve"; target: OpenTarget; distanceKm: number }
  | { choice: "lighter" };

type Props = {
  variant: WhatsNextVariant;
  // The race just run, for the race-first title.
  label?: string;
  // The distance just raced, else the plan's reference distance; 0 when unknown.
  kmRef: number;
  recap: Recap | null;
  // On a plan with no race already: the race option reads "Try a real race".
  blockRunner: boolean;
  participations: Participation[];
  runs: Run[];
  onAnswer: (answer: WhatsNextAnswer, feeling: Feeling | null) => void;
};

type Step = "recap" | "feeling" | "goals";

const PANEL = "w-full max-w-lg mx-auto max-h-full overflow-y-auto bg-slate-800 border-t border-slate-700 rounded-t-2xl p-4 space-y-4 animate-slide-up";
const OPTION = "w-full text-left rounded-xl border p-3 transition-colors ";
const CTA = "flex-shrink-0 rounded-lg bg-orange-500 hover:bg-orange-600 text-white px-3 py-1.5 text-xs font-semibold transition-colors";

export function WhatsNextSheet({ variant, label, kmRef, recap, blockRunner, participations, runs, onAnswer }: Props) {
  const { t } = useTranslation();
  const [feeling, setFeeling] = useState<Feeling | null>(null);
  const [step, setStep] = useState<Step>(variant === "raceFirst" ? "goals" : recap ? "recap" : "feeling");
  const answer = (a: WhatsNextAnswer) => onAnswer(a, feeling);
  const later = () => answer({ choice: "later" });
  useDismissable(true, later);
  useEffect(() => { track("whats_next_shown", { variant }); }, [variant]);

  const today = ymd(new Date());
  const near = useNearMeFilter("whatsnext_near_me");
  const lead = wishlistLead(participations, today);
  const suggestions = lead ? [] : raceSuggestions(searchEditions("", today), {
    today, km: kmRef, listed: participations, loc: near.nearMe ? near.loc : null,
  });
  const best = bestSecByKey(runs);
  const order = goalOrder(feeling, variant);
  const weeksAway = (date: string) => Math.max(1, Math.round((new Date(date + "T00:00:00").getTime() - new Date(today + "T00:00:00").getTime()) / (7 * 86400000)));

  const promotable = (p: Participation): Promotable => {
    const joined = findEdition(p.editionId);
    return joined ?? { name: String(p.label || ""), raceId: String(p.raceId || ""),
      edition: { id: String(p.editionId || ""), date: String(p.raceDate || ""), distanceKm: Number(p.distanceKm) || 0 } };
  };

  const raceRow = (name: string, date: string, km: number, onPick: () => void, sub?: string) => (
    <div key={name + date} className="flex items-center gap-3 rounded-xl bg-slate-900/60 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold truncate">{name}</p>
        <p className="text-xs text-slate-400 truncate">{[fmt.date(date), km + " km", t("whatsNext.race.weeks", { count: weeksAway(date) }), sub].filter(Boolean).join(" · ")}</p>
      </div>
      <button onClick={onPick} className={CTA}>{t("whatsNext.race.train")}</button>
    </div>
  );

  const option = (o: GoalOption) => {
    if (o === "race") return (
      <div key="race" className={OPTION + "border-orange-500/30 bg-orange-500/5 space-y-2.5"}>
        <div className="flex items-start gap-2.5">
          <Flag size={18} className="text-orange-300 shrink-0 mt-0.5"/>
          <div>
            <p className="text-sm font-semibold">{t(blockRunner ? "whatsNext.race.titleBlock" : "whatsNext.race.title")}</p>
            <p className="text-xs text-slate-400 mt-0.5">{t("whatsNext.race.sub")}</p>
          </div>
        </div>
        {lead ? (
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{t("whatsNext.race.wishlist")}</p>
            {raceRow(String(lead.label || ""), String(lead.raceDate), Number(lead.distanceKm) || 0, () => answer({ choice: "race", edition: promotable(lead) }))}
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{t("whatsNext.race.suggested")}</p>
              <button onClick={() => void near.toggleNearMe()} aria-pressed={near.nearMe}
                className={"flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors " + (near.nearMe
                  ? "text-orange-300 bg-orange-500/10 border-orange-500/40" : "text-slate-400 border-slate-600 hover:text-slate-200")}>
                <MapPin size={11}/>{near.status === "locating" ? t("whatsNext.race.locating") : t("whatsNext.race.nearMe")}
              </button>
            </div>
            {near.status === "denied" && <p role="alert" className="text-xs text-amber-300">{t("whatsNext.race.denied")}</p>}
            {suggestions.length
              ? suggestions.map(({ e, distM }) => raceRow(String(e.name), e.edition.date, Number(e.edition.distanceKm) || 0,
                  () => answer({ choice: "race", edition: e }), distM != null ? Math.round(distM / 1000) + " km" : undefined))
              : <p className="text-xs text-slate-400">{t("whatsNext.race.none")}</p>}
          </div>
        )}
        <button onClick={() => answer({ choice: "race", edition: null })}
          className="flex items-center gap-0.5 text-xs font-semibold text-slate-300 hover:text-white transition-colors">
          {t("whatsNext.race.browse")}<ChevronRight size={13}/>
        </button>
      </div>
    );
    if (o === "improve") return (
      <div key="improve" className={OPTION + "border-slate-700 bg-slate-900/40 space-y-2.5"}>
        <div className="flex items-start gap-2.5">
          <Sparkles size={18} className="text-emerald-300 shrink-0 mt-0.5"/>
          <div>
            <p className="text-sm font-semibold">{t("whatsNext.improve.title")}</p>
            <p className="text-xs text-slate-400 mt-0.5">{t("whatsNext.improve.sub")}</p>
          </div>
        </div>
        <div className="space-y-1.5">
          {FASTER_OPTIONS.map(({ key, km }) => (
            <button key={key} onClick={() => answer({ choice: "improve", target: "faster", distanceKm: km })}
              className="w-full flex items-center gap-3 rounded-xl bg-slate-800 hover:bg-slate-700 px-3 py-2.5 text-left transition-colors">
              <Gauge size={16} className="text-sky-300 shrink-0"/>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{t("whatsNext.improve.faster", { distance: t("whatsNext.improve." + (key === "5k" ? "d5" : key === "10k" ? "d10" : "dHalf")) })}</span>
                <span className="block text-xs text-slate-400">{best[key] ? t("whatsNext.improve.best", { time: fmt.dur(best[key]) }) : t("whatsNext.improve.noBest")}</span>
              </span>
            </button>
          ))}
          <button onClick={() => answer({ choice: "improve", target: "further", distanceKm: kmRef })}
            className="w-full flex items-center gap-3 rounded-xl bg-slate-800 hover:bg-slate-700 px-3 py-2.5 text-left transition-colors">
            <Mountain size={16} className="text-amber-300 shrink-0"/>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{t("whatsNext.improve.further")}</span>
              <span className="block text-xs text-slate-400">{t("whatsNext.improve.furtherSub")}</span>
            </span>
          </button>
          <button onClick={() => answer({ choice: "improve", target: "healthy", distanceKm: kmRef })}
            className="w-full flex items-center gap-3 rounded-xl bg-slate-800 hover:bg-slate-700 px-3 py-2.5 text-left transition-colors">
            <Leaf size={16} className="text-emerald-300 shrink-0"/>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{t("whatsNext.improve.healthy")}</span>
              <span className="block text-xs text-slate-400">{t("whatsNext.improve.healthySub")}</span>
            </span>
          </button>
        </div>
      </div>
    );
    return (
      <div key="lighter" className={OPTION + "border-emerald-500/30 bg-emerald-500/5 space-y-2.5"}>
        <div className="flex items-start gap-2.5">
          <Target size={18} className="text-emerald-300 shrink-0 mt-0.5"/>
          <div>
            <p className="text-sm font-semibold">{t("whatsNext.lighter.title")}</p>
            <p className="text-xs text-slate-400 mt-0.5">{t("whatsNext.lighter.sub")}</p>
          </div>
        </div>
        <button onClick={() => answer({ choice: "lighter" })}
          className="w-full rounded-xl bg-emerald-500 hover:bg-emerald-600 text-slate-900 py-2.5 text-sm font-semibold transition-colors">
          {t("whatsNext.lighter.cta")}
        </button>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-[2000] flex items-end animate-overlay-fade" onClick={later}>
      <div className={PANEL} style={{ paddingBottom: "calc(1.5rem + var(--safe-bottom))" }} onClick={e => e.stopPropagation()}>
        <div className="w-9 h-1 rounded-full bg-slate-600 mx-auto"/>
        <p className="text-orange-300 text-xs font-semibold uppercase tracking-widest">{t("whatsNext.eyebrow")}</p>

        {step === "recap" && recap && (
          <>
            <div>
              <h3 className="text-base font-bold">{t(blockRunner ? "whatsNext.recap.titleOpen" : "whatsNext.recap.title")}</h3>
              <p className="text-xs text-slate-400 mt-0.5">{t("whatsNext.recap.sub")}</p>
            </div>
            <BlockRecap recap={recap}/>
            <button onClick={() => setStep("feeling")}
              className="w-full bg-orange-500 hover:bg-orange-600 text-white py-2.5 rounded-xl text-sm font-semibold transition-colors">
              {t("whatsNext.continue")}
            </button>
          </>
        )}

        {step === "feeling" && (
          <>
            <div>
              <h3 className="text-base font-bold">{t("whatsNext.feeling.title")}</h3>
              <p className="text-xs text-slate-400 mt-0.5">{t("whatsNext.feeling.sub")}</p>
            </div>
            <div className="space-y-2">
              {FEELINGS.map(f => (
                <button key={f} onClick={() => { setFeeling(f); setStep("goals"); }}
                  className="w-full text-left rounded-xl bg-slate-900/60 hover:bg-slate-700/60 border border-slate-700 px-4 py-3 transition-colors">
                  <span className="block text-sm font-semibold">{t("whatsNext.feeling." + f)}</span>
                  <span className="block text-xs text-slate-400 mt-0.5">{t("whatsNext.feeling." + f + "Sub")}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === "goals" && (
          <>
            {variant === "raceFirst" ? (
              <div className="text-center">
                <h3 className="text-base font-bold">{t("whatsNext.goals.raceFirstTitle", { label })}</h3>
                <p className="text-xs text-slate-400 mt-0.5">{t("whatsNext.goals.raceFirstSub")}</p>
              </div>
            ) : (
              <h3 className="text-base font-bold">{t("whatsNext.goals.title")}</h3>
            )}
            <div className="space-y-3">{order.map(option)}</div>
          </>
        )}

        <button onClick={later} className="block mx-auto text-sm text-slate-400 hover:text-slate-200 transition-colors">
          {t("whatsNext.later")}
        </button>
      </div>
    </div>
  );
}
