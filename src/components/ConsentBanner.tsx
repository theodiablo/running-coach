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

// First-run opt-in consent (EU/ePrivacy): telemetry stays fully off until the
// user makes a choice here, so PostHog never inits — and never stores anything
// on the device — before consent. Self-gating: renders nothing unless telemetry
// is actually configured (a key is set) AND the user hasn't decided yet, so it
// disappears for good once answered. The Settings → Privacy toggles remain the
// durable control to change the choice later.
//
// Two presentations, one gate. Native gets the full-screen ConsentScreen, where
// crash reports and product analytics are separate switches — a phone has the
// room, and it's the app's first screen either way. The web keeps the compact
// bottom bar: a full-screen interstitial over the marketing landing would be a
// worse trade, so Accept/Decline there answers both channels together.
//
// `onConsentChange(analyticsGranted)` lets the host re-identify the signed-in
// user the moment they accept analytics (events before that point are anonymous;
// later events use the signed-in user id).
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
