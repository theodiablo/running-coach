import { useTranslation } from "react-i18next";
import { InfoButton, InfoSection } from "./InfoButton";
import { BetaBadge } from "./BetaBadge";

const RESEARCH = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const METHOD = [1, 2, 3, 4, 5, 6] as const;

// The stretching FAQ: the research, then how the app applies it. Shown in the
// routine sheet's info panel and in Settings → Help & FAQ.
export function StretchInfoBody() {
  const { t } = useTranslation();
  return (
    <>
      <div className="rounded-2xl border border-amber-400/30 bg-amber-400/5 p-3 space-y-1.5">
        <BetaBadge label={t("stretch.info.testingBadge")}/>
        <p className="text-xs text-amber-100/90 leading-relaxed">{t("stretch.info.testing")}</p>
      </div>
      <p className="text-slate-300 text-sm">{t("stretch.info.intro")}</p>
      <InfoSection title={t("stretch.info.researchTitle")} accent="text-teal-300">
        {RESEARCH.map(n => (
          <div key={n} className="space-y-0.5">
            <p className="text-slate-200 font-medium">{t(`stretch.info.q${n}`)}</p>
            <p>{t(`stretch.info.a${n}`)}</p>
          </div>
        ))}
      </InfoSection>
      <InfoSection title={t("stretch.info.methodTitle")} accent="text-teal-300">
        {METHOD.map(n => (
          <div key={n} className="space-y-0.5">
            <p className="text-slate-200 font-medium">{t(`stretch.info.m${n}`)}</p>
            <p>{t(`stretch.info.n${n}`)}</p>
          </div>
        ))}
      </InfoSection>
      <p className="text-slate-500 text-xs">{t("stretch.info.sources")}</p>
    </>
  );
}

export function StretchInfo() {
  const { t } = useTranslation();
  return (
    <InfoButton title={t("stretch.info.title")} label={t("stretch.info.label")}>
      <StretchInfoBody/>
    </InfoButton>
  );
}
