import { useEffect, useRef, useState } from "react";
import { PartyPopper, Sparkles, Trophy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Confetti } from "../components/Confetti";
import { EffortRow } from "../components/EffortRow";
import { useDismissable } from "../hooks/useDismissable";
import { fmt } from "../utils/format";
import { isPersonalBest } from "../utils/bestEfforts";
import type { Celebration } from "../utils/runCelebration";
import type { Run } from "../types";

// Long enough to read a headline and one line; best-effort rows wait for a tap.
const AUTO_CLOSE_MS = 4000;
// The thumb that just held Finish must not dismiss this on release.
const ARM_MS = 450;

type Props = {
  celebration: Celebration;
  run: Run;
  onClose: () => void;
};

// The moment between Finish and the run summary. docs/run-celebration.md.
export function RunCelebration({ celebration, run, onClose }: Props) {
  const { t } = useTranslation();
  useDismissable(true, onClose);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  const [armed, setArmed] = useState(false);
  const { headline, fact, efforts, confetti, rare } = celebration;
  const lingers = efforts.length > 0;

  useEffect(() => {
    const arm = setTimeout(() => setArmed(true), ARM_MS);
    const auto = lingers ? null : setTimeout(() => closeRef.current(), AUTO_CLOSE_MS);
    return () => { clearTimeout(arm); if (auto) clearTimeout(auto); };
  }, [lingers]);

  const indoor = !run.km;
  const pace = run.km && run.durationSec ? run.durationSec / run.km : 0;
  const summary = indoor
    ? t("celebration.summaryIndoor", { dur: fmt.dur(run.durationSec) })
    : t("celebration.summary", { km: run.km, dur: fmt.dur(run.durationSec), pace: fmt.pace(pace) });
  const Icon = efforts.some(isPersonalBest) ? Trophy : rare ? Sparkles : PartyPopper;

  return (
    <>
      {confetti && <Confetti />}
      <div role="dialog" aria-modal="true" aria-labelledby="run-celebration-title"
        onClick={() => { if (armed) onClose(); }}
        className="fixed inset-0 z-[2000] bg-slate-950/95 flex items-center justify-center px-6 animate-overlay-fade"
        style={{ paddingTop: "calc(1.5rem + var(--safe-top))", paddingBottom: "calc(1.5rem + var(--safe-bottom))" }}>
        <div className="max-w-sm w-full text-center space-y-4">
          <div className="mx-auto w-16 h-16 rounded-full bg-orange-500/15 border border-orange-500/40 flex items-center justify-center animate-pop">
            <Icon size={30} className="text-orange-300" aria-hidden />
          </div>
          {rare && (
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide bg-amber-400/15 text-amber-300 border border-amber-400/40">
              <Sparkles size={12} aria-hidden />{t("celebration.rareTag")}
            </span>
          )}
          <h2 id="run-celebration-title" className="text-3xl font-extrabold text-white leading-tight animate-scale-in">
            {t(headline)}
          </h2>
          {fact && <p className="text-base font-medium text-orange-200 animate-slide-up">{t(fact.key, fact.vars)}</p>}
          <p className="text-sm text-slate-400 tabular-nums">{summary}</p>
          {lingers && (
            <div className="space-y-2 text-left">
              {efforts.map(e => <EffortRow key={e.key} effort={e} />)}
            </div>
          )}
          {lingers ? (
            <button onClick={e => { e.stopPropagation(); if (armed) onClose(); }}
              className="w-full py-3 rounded-xl text-sm font-semibold bg-orange-500 hover:bg-orange-600 text-white">
              {t("celebration.continue")}
            </button>
          ) : (
            <p className="text-xs text-slate-500">{t("celebration.tapHint")}</p>
          )}
        </div>
      </div>
    </>
  );
}
