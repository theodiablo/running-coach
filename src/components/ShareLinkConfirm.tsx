// In-DOM confirm for the share-link decisions (never window.confirm). Registers its own
// useDismissable so Android back / Escape close it and go-Home can clear it. Shared by the
// recorder and Settings → Account: replacing a link is the same act in both.
import { useTranslation } from "react-i18next";
import { useDismissable } from "../hooks/useDismissable";
import { ModalOverlay, ConfirmButtons } from "./ModalPrimitives";

export function ShareLinkConfirm({ title, body, acceptLabel, onCancel, onAccept }: {
  title: string; body: string; acceptLabel: string; onCancel: () => void; onAccept: () => void;
}) {
  const { t } = useTranslation();
  useDismissable(true, onCancel);
  return (
    <ModalOverlay>
      <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-slate-700 p-4 space-y-3">
        <p className="text-sm font-semibold text-slate-100">{title}</p>
        <p className="text-xs text-slate-400 leading-snug">{body}</p>
        <ConfirmButtons cancelLabel={t("common.cancel")} acceptLabel={acceptLabel}
          onCancel={onCancel} onAccept={onAccept} />
      </div>
    </ModalOverlay>
  );
}
