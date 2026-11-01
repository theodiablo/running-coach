import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Shield } from "lucide-react";
import { PRIVACY_URL } from "../constants";
import {
  isTelemetryConfigured,
  getConsentDecision,
  setTelemetryConsent,
  type ConsentChoice,
} from "../telemetry";
import { isNative } from "../native";
import { ConsentScreen } from "./ConsentScreen";

// First-run opt-in consent (EU/ePrivacy): telemetry stays fully off, storing nothing, until the user chooses.
// Self-gating: renders nothing unless a telemetry key is set AND the user hasn't decided. Native gets the full-screen
// ConsentScreen (separate crash/analytics switches); web keeps the compact bar, where Accept/Decline answers both.
// `onConsentChange(analyticsGranted)` lets the host re-identify the signed-in user once analytics is accepted.
type ConsentBannerProps = { onConsentChange?: (granted: boolean) => void };

export function ConsentBanner({ onConsentChange }: ConsentBannerProps) {
  const { t } = useTranslation();
  const [show, setShow] = useState(
    () => isTelemetryConfigured() && getConsentDecision() === "unset"
  );
  if (!show) return null;

  const choose = (choice: ConsentChoice) => {
    setTelemetryConsent(choice);
    setShow(false);
    if (onConsentChange) onConsentChange(choice.analytics);
  };

  if (isNative) return <ConsentScreen onSubmit={choose} />;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] p-3 sm:p-4 pb-[calc(0.75rem+var(--safe-bottom))] sm:pb-[calc(1rem+var(--safe-bottom))]">
      <div className="max-w-lg mx-auto bg-slate-800 border border-slate-700 rounded-2xl shadow-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Shield size={15} className="text-orange-400 shrink-0" />
          <p className="text-sm font-semibold text-slate-200">
            {t("app.consent.title")}
          </p>
        </div>
        <p className="text-xs text-slate-400">
          {t("app.consent.body")}{" "}
          <a
            href={PRIVACY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-orange-400 hover:text-orange-300 underline"
          >
            {t("app.consent.privacyPolicy")}
          </a>
        </p>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => choose({ analytics: false, crashes: false })}
            className="py-2.5 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors"
          >
            {t("app.consent.decline")}
          </button>
          <button
            onClick={() => choose({ analytics: true, crashes: true })}
            className="py-2.5 rounded-xl text-sm font-semibold bg-orange-500 hover:bg-orange-600 text-white transition-colors"
          >
            {t("app.consent.accept")}
          </button>
        </div>
      </div>
    </div>
  );
}
