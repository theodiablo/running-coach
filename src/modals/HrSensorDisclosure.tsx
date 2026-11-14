import { useTranslation, Trans } from "react-i18next";
import { useDismissable } from "../hooks/useDismissable";
import { HeartPulse } from "lucide-react";
import { PRIVACY_URL } from "../constants";
import { ModalOverlay, PermissionPrimerButtons } from "../components/ModalPrimitives";
import { BetaBadge } from "../components/BetaBadge";

type HrSensorDisclosureProps = { onAccept: () => void; onCancel: () => void };

// Prominent disclosure shown before the first Bluetooth permission prompt when
// pairing a heart-rate sensor (native shell). Mirrors BgLocationDisclosure: the
// user accepts in-app, then the OS dialog gates the actual BLUETOOTH_SCAN/CONNECT
// grant. Gated once per install in SettingsModal via HR_BLE_DISCLOSED_KEY.
export function HrSensorDisclosure({ onAccept, onCancel }: HrSensorDisclosureProps) {
  const { t } = useTranslation();
  useDismissable(true, onCancel);
  return (
    <ModalOverlay>
      <div className="bg-slate-800 rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto border border-slate-700">
        <div className="px-4 py-3 border-b border-slate-700 flex items-center gap-2">
          <HeartPulse size={16} className="text-orange-400" />
          <p className="font-semibold text-sm">{t("settings.hrDisclosure.title")}</p>
          <BetaBadge label={t("settings.newBeta")} />
        </div>
        <div className="p-4 space-y-3 text-sm text-slate-300">
          <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs leading-snug text-amber-100">
            {t("settings.hrDisclosure.warning")}
          </div>
          <p>
            <Trans i18nKey="settings.hrDisclosure.intro" components={{ bold: <strong /> }} />
          </p>
          <ul className="list-disc pl-5 space-y-1 text-[13px] text-slate-400">
            <li><Trans i18nKey="settings.hrDisclosure.bullet1" components={{ bold: <strong /> }} /></li>
            <li>{t("settings.hrDisclosure.bullet2")}</li>
            <li>{t("settings.hrDisclosure.bullet3")}</li>
          </ul>
          <p className="text-[13px] text-slate-400">
            <Trans
              i18nKey="settings.hrDisclosure.policy"
              components={{
                link: (
                  <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer"
                    className="text-orange-400 underline" />
                ),
              }}
            />
          </p>
          <PermissionPrimerButtons cancelLabel={t("common.notNow")} acceptLabel={t("settings.hrDisclosure.accept")}
            onCancel={onCancel} onAccept={onAccept} />
        </div>
      </div>
    </ModalOverlay>
  );
}
