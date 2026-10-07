import { useTranslation, Trans } from "react-i18next";
import { InfoButton, InfoSection } from "./InfoButton";

// "ⓘ info" affordance + panel explaining how the training plan is built from the
// goal. Mirrors the actual logic in utils/plan.js so the explanation stays honest. Its body is
// also shown in Settings → Help & FAQ.
export function PlanInfoBody() {
  const { t } = useTranslation();
  return (
    <>
      <p className="text-slate-300 text-sm">
        <Trans i18nKey="progress.planInfo.intro" components={[
          <span className="text-white font-medium"/>,
          <span className="text-white font-medium"/>,
          <span className="text-white font-medium"/>,
        ]}/>
      </p>

      <InfoSection title={t("progress.planInfo.s1Title")}>
        <p>
          <Trans i18nKey="progress.planInfo.s1P1" components={[<span className="text-orange-300"/>]}/>
        </p>
        <p>{t("progress.planInfo.s1P2")}</p>
        <ul className="list-disc pl-4 space-y-0.5">
          <li><Trans i18nKey="progress.planInfo.s1Easy" components={[<span className="text-emerald-400 font-medium"/>]}/></li>
          <li><Trans i18nKey="progress.planInfo.s1Tempo" components={[<span className="text-yellow-400 font-medium"/>]}/></li>
          <li><Trans i18nKey="progress.planInfo.s1Intervals" components={[<span className="text-orange-400 font-medium"/>]}/></li>
        </ul>
      </InfoSection>

      <InfoSection title={t("progress.planInfo.s2Title")} accent="text-sky-400">
        <p>
          {t("progress.planInfo.s2P1")}
        </p>
        <ul className="list-disc pl-4 space-y-0.5">
          <li><Trans i18nKey="progress.planInfo.s2Base" components={[<span className="text-sky-400 font-medium"/>]}/></li>
          <li><Trans i18nKey="progress.planInfo.s2Build" components={[<span className="text-yellow-400 font-medium"/>]}/></li>
          <li><Trans i18nKey="progress.planInfo.s2Peak" components={[<span className="text-red-400 font-medium"/>]}/></li>
          <li><Trans i18nKey="progress.planInfo.s2Taper" components={[<span className="text-emerald-400 font-medium"/>]}/></li>
        </ul>
      </InfoSection>

      <InfoSection title={t("progress.planInfo.s3Title")} accent="text-violet-400">
        <p>
          <Trans i18nKey="progress.planInfo.s3Body" components={[
            <span className="text-sky-400"/>,
            <span className="text-yellow-400"/>,
          ]}/>
        </p>
      </InfoSection>

      <p className="text-slate-500 text-xs">
        {t("progress.planInfo.footer")}
      </p>
    </>
  );
}

export function PlanInfo() {
  const { t } = useTranslation();
  return (
    <InfoButton title={t("progress.planInfo.title")} label={t("progress.planInfo.label")}>
      <PlanInfoBody/>
    </InfoButton>
  );
}
