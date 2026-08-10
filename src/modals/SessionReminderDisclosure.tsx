import { useTranslation, Trans } from "react-i18next";
import { useDismissable } from "../hooks/useDismissable";
import { BellRing } from "lucide-react";
import { ModalOverlay, ConfirmButtons } from "../components/ModalPrimitives";

type SessionReminderDisclosureProps = { onAccept: () => void; onCancel: () => void };

// Prominent disclosure shown before the first notification permission prompt for
// plan-session reminders (native shell). Mirrors HrSensorDisclosure /
// BgLocationDisclosure: the user accepts in-app, then the OS dialog gates the
// actual grant. Shown once per install via SESSION_NOTIF_DISCLOSED_KEY.
export function SessionReminderDisclosure({ onAccept, onCancel }: SessionReminderDisclosureProps) {
  const { t } = useTranslation();
  useDismissable(true, onCancel);
  return (
    <ModalOverlay>
      <div className="bg-slate-800 rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto border border-slate-700">
        <div className="px-4 py-3 border-b border-slate-700 flex items-center gap-2">
          <BellRing size={16} className="text-orange-400" />
          <p className="font-semibold text-sm">{t("reminders.disclosure.title")}</p>
        </div>
        <div className="p-4 space-y-3 text-sm text-slate-300">
          <p><Trans i18nKey="reminders.disclosure.intro" components={{ bold: <strong /> }} /></p>
          <ul className="list-disc pl-5 space-y-1 text-[13px] text-slate-400">
            <li><Trans i18nKey="reminders.disclosure.bullet1" components={{ bold: <strong /> }} /></li>
            <li>{t("reminders.disclosure.bullet2")}</li>
            <li>{t("reminders.disclosure.bullet3")}</li>
          </ul>
          <ConfirmButtons cancelLabel={t("reminders.disclosure.cancel")} acceptLabel={t("reminders.disclosure.accept")}
            onCancel={onCancel} onAccept={onAccept} />
        </div>
      </div>
    </ModalOverlay>
  );
}
