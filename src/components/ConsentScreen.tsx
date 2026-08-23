import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import { BrandLogo } from "./BrandLogo";
import { ToggleSwitch } from "./ToggleSwitch";
import { PRIVACY_URL } from "../constants";
import type { ConsentChoice } from "../telemetry";

// The native first-run consent screen: the same two-channel choice the web bar
// offers, given a full screen because a phone has one. Both switches start OFF
// — a pre-ticked box is not consent — so "Continue" without touching anything
// is a complete, valid refusal, which is why there is no separate skip.
// Visibility and persistence belong to ConsentBanner; this is just the choice.
//
// Deliberately not registered with useDismissable (like OnboardingWizard): it
// renders over the login screen, before the back/Escape dispatcher exists.
type ConsentScreenProps = { onSubmit: (choice: ConsentChoice) => void };

function ConsentOption(
  { title, desc, on, onToggle }: { title: string; desc: string; on: boolean; onToggle: () => void },
) {
  return (
    <div className="flex items-start justify-between gap-4 bg-slate-800/60 border border-slate-700 rounded-2xl p-4">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-100">{title}</p>
        <p className="text-xs text-slate-400 mt-1 leading-relaxed">{desc}</p>
      </div>
      <ToggleSwitch on={on} onToggle={onToggle} label={title} />
    </div>
  );
}

export function ConsentScreen({ onSubmit }: ConsentScreenProps) {
  const { t } = useTranslation();
  const [crashes, setCrashes] = useState(false);
  const [analytics, setAnalytics] = useState(false);

  return (
    <div className="fixed inset-0 z-[60] bg-slate-900 overflow-y-auto"
      style={{ paddingTop: "var(--safe-top)", paddingBottom: "var(--safe-bottom)" }}>
      <div className="min-h-full max-w-md mx-auto px-5 py-6 flex flex-col">
        <div className="flex items-center justify-center gap-2">
          <BrandLogo className="text-orange-400" size={24} />
          <p className="text-sm font-bold tracking-wide text-orange-400 uppercase">{t("login.brand")}</p>
        </div>

        <h1 className="mt-5 text-2xl font-bold text-white text-center">{t("app.consent.screenTitle")}</h1>
        <p className="mt-2.5 text-sm text-slate-400 text-center leading-relaxed">{t("app.consent.screenBody")}</p>

        <div className="mt-6 space-y-3">
          <ConsentOption title={t("app.consent.crashTitle")} desc={t("app.consent.crashDesc")}
            on={crashes} onToggle={() => setCrashes(v => !v)} />
          <ConsentOption title={t("app.consent.analyticsTitle")} desc={t("app.consent.analyticsDesc")}
            on={analytics} onToggle={() => setAnalytics(v => !v)} />
          <div className="flex items-center gap-2 pt-1 text-xs text-slate-400">
            <Lock size={13} className="text-slate-500 shrink-0" />
            <span>{t("app.consent.control")}</span>
            <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer"
              className="text-orange-400 hover:text-orange-300 underline">
              {t("app.consent.privacyPolicy")}
            </a>
          </div>
        </div>

        <div className="mt-auto pt-6">
          <button onClick={() => onSubmit({ analytics, crashes })}
            className="w-full py-3.5 rounded-2xl text-base font-semibold bg-orange-500 hover:bg-orange-600 text-white transition-colors">
            {t("app.consent.continue")}
          </button>
          <p className="mt-3 text-xs text-slate-500 text-center">{t("app.consent.changeLater")}</p>
        </div>
      </div>
    </div>
  );
}
