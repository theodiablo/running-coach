// The post-run reward: right after a run is saved, how it stacks up against the
// log. Free on every platform and deliberately so — it costs nothing to compute
// (see src/utils/bestEfforts.ts) and it's the moment that makes finishing a run
// in the app worthwhile. The ranked *history* behind it is the premium
// deep-analytics surface; see docs/monetization.md.
//
// Only ever mounted when there's something worth saying (runAchievements
// returned rows), so there is no "nothing to report" state to design.

import { Trophy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Confetti } from "../components/Confetti";
import { EffortRow } from "../components/EffortRow";
import { ModalOverlay } from "../components/ModalPrimitives";
import { useDismissable } from "../hooks/useDismissable";
import { fmt } from "../utils/format";
import { isFirstEffort, isPersonalBest, type EffortRank } from "../utils/bestEfforts";
import type { Run } from "../types";

type Props = {
  run: Run;
  // Best-rank-first, guaranteed non-empty by the caller.
  efforts: EffortRank[];
  // Owned by the caller so a race-day celebration doesn't fire two bursts.
  confetti?: boolean;
  onClose: () => void;
};

export function RunAchievementSheet({ run, efforts, confetti, onClose }: Props) {
  const { t } = useTranslation();
  // Registered here, in the overlay's own component, so Android back / Escape
  // close it via the LIFO dismiss registry.
  useDismissable(true, onClose);

  const top = efforts[0];
  const title = isPersonalBest(top) ? "titlePb" : isFirstEffort(top) ? "titleFirst" : "titleRank";
  const pace = run.km && run.durationSec ? run.durationSec / run.km : 0;

  return (
    <>
      {/* No onDone: the keyframe settles at opacity 0 with `both` fill, so the
          burst plays once and the instance sits inert until the sheet closes. */}
      {confetti && <Confetti />}
      <ModalOverlay>
        <div className="bg-slate-800 rounded-2xl p-5 max-w-sm w-full space-y-4">
          <div className="text-center space-y-1.5">
            <div className="mx-auto w-11 h-11 rounded-full bg-orange-500/15 border border-orange-500/40 flex items-center justify-center">
              <Trophy size={20} className="text-orange-300" />
            </div>
            <h3 className="text-lg font-bold text-white">{t("bestEfforts.sheet." + title)}</h3>
            <p className="text-xs text-slate-400 tabular-nums">
              {t("bestEfforts.sheet.summary", { km: run.km, dur: fmt.dur(run.durationSec), pace: fmt.pace(pace) })}
            </p>
          </div>
          <div className="space-y-2">
            {efforts.map(e => <EffortRow key={e.key} effort={e} />)}
          </div>
          <button onClick={onClose}
            className="w-full py-2.5 rounded-xl text-sm font-semibold bg-orange-500 hover:bg-orange-600 text-white">
            {t("bestEfforts.sheet.close")}
          </button>
        </div>
      </ModalOverlay>
    </>
  );
}
