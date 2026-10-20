import { useTranslation, Trans } from "react-i18next";
import { InfoButton, InfoSection } from "./InfoButton";
import { HR_ZONES, effectiveMaxHR, hrZoneBpm } from "../utils/hr";
import type { SettingsState } from "../types";

type HrZonesInfoProps = { settings?: Partial<SettingsState> | null };

// How the heart-rate zones are calculated, worked through on the runner's own
// profile when one exists. Mirrors utils/hr.ts; also shown in Settings → Help & FAQ.
export function HrZonesInfoBody({settings}: HrZonesInfoProps) {
  const { t } = useTranslation();
  const max = settings ? effectiveMaxHR(settings) : 0;
  const rest = settings?.restHR || 60;
  const hrr = max - rest;
  const own = max > 0 && hrr > 0;
  const z2 = HR_ZONES[1];
  const z2Top = own ? hrZoneBpm(z2.lo, z2.hi, max, rest)!.hi : null;
  const pct = (f: number) => Math.round(f * 100);

  return (
    <>
      <p className="text-slate-300 text-sm">
        <Trans i18nKey="progress.zones.info.intro" components={[<span className="text-white font-medium"/>]}/>
      </p>

      <InfoSection title={t("progress.zones.info.formulaTitle")}>
        <p className="font-mono text-slate-300 text-[11px] bg-slate-900/60 rounded-lg p-2">
          {t("progress.zones.info.formula")}
        </p>
        <p>{t("progress.zones.info.formulaP")}</p>
        {own ? (
          <p className="text-slate-300">
            {t("progress.zones.info.yours", {max, rest, hrr, pct: pct(z2.hi), top: z2Top})}
          </p>
        ) : (
          <p>{t(max > 0 ? "progress.zones.info.badProfile" : "progress.zones.info.noProfile")}</p>
        )}
      </InfoSection>

      <InfoSection title={t("progress.zones.info.zonesTitle")}>
        <div className="space-y-1">
          {HR_ZONES.map(z => {
            const r = own ? hrZoneBpm(z.lo, z.hi, max, rest) : null;
            return (
              <div key={z.n} className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{background: z.clr}}/>
                <span className="flex-1 text-slate-300">{t("progress.zones.zoneLabel", {n: z.n, name: t("progress.zones.names." + z.n)})}</span>
                <span className="tabular-nums">{pct(z.lo) + "–" + pct(z.hi) + "%"}</span>
                {r && <span className="w-16 text-right tabular-nums text-slate-300">{r.lo + "–" + r.hi}</span>}
              </div>
            );
          })}
        </div>
        <p>{t("progress.zones.info.sessions")}</p>
      </InfoSection>

      <InfoSection title={t("progress.zones.info.inputsTitle")} accent="text-sky-400">
        <p>{t("progress.zones.info.inputsMax")}</p>
        <p>{t("progress.zones.info.inputsRest")}</p>
      </InfoSection>

      <InfoSection title={t("progress.zones.info.otherTitle")} accent="text-emerald-400">
        <p>{t("progress.zones.info.otherP1")}</p>
        <p>{t("progress.zones.info.otherP2")}</p>
      </InfoSection>
    </>
  );
}

export function HrZonesInfo({settings}: HrZonesInfoProps) {
  const { t } = useTranslation();
  return (
    <InfoButton title={t("progress.zones.info.title")} label={t("progress.zones.info.label")}>
      <HrZonesInfoBody settings={settings}/>
    </InfoButton>
  );
}
