// The "this is a premium feature" sheet a free user gets in place of a premium
// entry point. No payment words (no purchase flow yet — App Store 3.1.1) and
// never asserts the viewer's tier (an offline premium user can land here too).
// Dormant for free users while `canShowPremiumTeaser` is false; still reachable
// by a premium user whose grant lapsed mid-session. See docs/monetization.md.

import { Lock } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ModalOverlay } from "../components/ModalPrimitives";
import { useDismissable } from "../hooks/useDismissable";
import { track } from "../telemetry";

type PremiumTeaserSheetProps = {
  // Which premium feature was tapped — an enum-ish slug, for the demand signal.
  feature: string;
  onClose: () => void;
};

export function PremiumTeaserSheet({ feature, onClose }: PremiumTeaserSheetProps) {
  const { t } = useTranslation();
  // Registered here, in the overlay's own component, so Android back / Escape
  // close it via the LIFO dismiss registry.
  useDismissable(true, onClose);

  // Demand signal: how many people reach for a premium feature before there is
  // anything to sell. Consent-gated inside track(); the slug is a fixed enum,
  // no free text.
  useEffect(() => { track("premium_teaser_shown", { feature }); }, [feature]);

  return (
    <ModalOverlay>
      <div className="bg-slate-800 rounded-2xl p-5 max-w-sm w-full space-y-3 text-center">
        <div className="mx-auto w-11 h-11 rounded-full bg-orange-500/15 border border-orange-500/40 flex items-center justify-center">
          <Lock size={20} className="text-orange-300" />
        </div>
        <h3 className="text-lg font-bold text-white">{t("premium.teaser.title")}</h3>
        <p className="text-sm text-slate-300 leading-relaxed">{t("premium.teaser.body")}</p>
        <button onClick={onClose}
          className="w-full py-2.5 rounded-xl text-sm font-semibold bg-orange-500 hover:bg-orange-600 text-white">
          {t("premium.teaser.ok")}
        </button>
      </div>
    </ModalOverlay>
  );
}
