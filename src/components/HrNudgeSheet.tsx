import { useTranslation } from "react-i18next";
import { HeartPulse } from "lucide-react";
import { useDismissable } from "../hooks/useDismissable";
import { ModalOverlay, ConfirmButtons } from "./ModalPrimitives";
import { BetaBadge } from "./BetaBadge";
import type { HrNudgeChoice } from "../utils/hrNudge";

// The "set up heart rate" prompt both recorders raise on Start. One component,
// because the two screens ask the same question about the same seam — and the
// copy, the beta warning and the opt-out rules must not drift between them.
// `hrNudgeFor` decides WHICH prompt; this is what it says.
export function HrNudgeSheet({ choice, onDismiss, onConfigure, onDecline }: {
  choice: HrNudgeChoice;
  /** `run` = go ahead with the start this prompt replaced. */
  onDismiss: (run: boolean) => void;
  onConfigure?: () => void;
  onDecline?: () => void;
}) {
  const { t } = useTranslation();
  // Back/Escape cancel outright — unlike "Not now", which goes on to start.
  useDismissable(true, () => onDismiss(false));
  const copy = {
    auth:   { title: t("tracker.hrNudge.authTitle"),   body: t("tracker.hrNudge.authBody"),   acceptLabel: t("tracker.hrNudge.authAccept") },
    hkAuth: { title: t("tracker.hrNudge.hkAuthTitle"), body: t("tracker.hrNudge.hkAuthBody"), acceptLabel: t("tracker.hrNudge.authAccept") },
    pair:   { title: t("tracker.hrNudge.pairTitle"),   body: t("tracker.hrNudge.pairBody"),   acceptLabel: t("tracker.hrNudge.pairAccept") },
    setup:  { title: t("tracker.hrNudge.setupTitle"),  body: t("tracker.hrNudge.setupBody"),  acceptLabel: t("tracker.hrNudge.setupAccept") },
  }[choice.id];

  return (
    <ModalOverlay>
      <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-slate-700 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <HeartPulse size={16} className="text-orange-400" />
          <p className="font-semibold text-sm">{copy.title}</p>
          <BetaBadge label={t("tracker.hrNudge.newBeta")} />
        </div>
        <p className="text-sm text-slate-300">{copy.body}</p>
        <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs leading-snug text-amber-100">
          {t("tracker.hrNudge.betaWarning")}
        </p>
        <ConfirmButtons cancelLabel={t("common.notNow")} acceptLabel={copy.acceptLabel}
          onCancel={() => onDismiss(true)}
          onAccept={() => { onDismiss(false); onConfigure?.(); }} />
        {choice.allowOptOut && (
          <button onClick={() => { onDismiss(true); onDecline?.(); }}
            className="w-full text-center text-xs text-slate-500 hover:text-slate-300">
            {t("tracker.hrNudge.optOut")}
          </button>
        )}
      </div>
    </ModalOverlay>
  );
}
