import { useTranslation } from "react-i18next";
import { fmt } from "../utils/format";
import type { BlockRecap as Recap } from "../utils/blockRecap";

// The numbers of a finished block: sessions, distance, longest run and, when the
// log supports it, the easy-pace trend. Free (docs/monetization.md). The sheet
// and Home's "Block n done" row share it.

const TILE = "bg-slate-900/60 rounded-xl p-3";

export function BlockRecap({ recap }: { recap: Recap }) {
  const { t } = useTranslation();
  const pace = recap.easyPace;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className={TILE}>
          <p className="text-lg font-bold text-orange-300">{t("whatsNext.recap.sessionsValue", { done: recap.sessionsDone, planned: recap.sessionsPlanned })}</p>
          <p className="text-[11px] text-slate-400 mt-0.5">{t("whatsNext.recap.sessions")}</p>
        </div>
        <div className={TILE}>
          <p className="text-lg font-bold text-orange-300">{t("whatsNext.recap.km", { km: recap.km })}</p>
          <p className="text-[11px] text-slate-400 mt-0.5">{t("whatsNext.recap.distance")}</p>
        </div>
        <div className={TILE}>
          <p className="text-lg font-bold text-orange-300">{t("whatsNext.recap.km", { km: recap.longestKm })}</p>
          <p className="text-[11px] text-slate-400 mt-0.5">{t("whatsNext.recap.longest")}</p>
        </div>
      </div>
      {pace && (
        <div className={TILE + " text-center"}>
          <p className="text-lg font-bold text-orange-300">
            {t("whatsNext.recap.easyPaceValue", { from: fmt.pace(pace.from), to: fmt.pace(pace.to) })}
          </p>
          <p className="text-[11px] text-slate-400 mt-0.5">{t("whatsNext.recap.easyPace")}</p>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {pace.atHr != null ? t("whatsNext.recap.easyPaceHr", { hr: pace.atHr }) : t("whatsNext.recap.easyPaceNoHr")}
          </p>
        </div>
      )}
    </div>
  );
}

// Home's row after an open plan's checkpoint run: the block just finished.
export function BlockDoneCard({ block, recap }: { block: number; recap: Recap }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-2xl p-4 border border-slate-700 bg-slate-800/60 space-y-3">
      <div>
        <p className="font-semibold text-sm">{t("dashboard.openPlan.blockDone", { block })}</p>
        <p className="text-xs text-slate-400 mt-0.5">{t("dashboard.openPlan.blockDoneSub")}</p>
      </div>
      <BlockRecap recap={recap}/>
    </div>
  );
}
