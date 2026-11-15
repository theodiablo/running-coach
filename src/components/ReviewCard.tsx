import { useTranslation } from "react-i18next";
import { Star } from "lucide-react";
import { isIos } from "../native";
import { useSeenOnScreen } from "../hooks/useSeenOnScreen";

export type ReviewAnswer = "review" | "later" | "never";

// The developer's own ask for a store review (docs/release.md, "Store prompts").
// An ask is counted once the card has actually been on screen.
export function ReviewCard({ ask, onSeen, onAnswer }: {
  ask: number;
  onSeen: () => void;
  onAnswer: (a: ReviewAnswer) => void;
}) {
  const { t } = useTranslation();
  const ref = useSeenOnScreen<HTMLDivElement>(true, onSeen);
  return (
    <div ref={ref} role="status" className="rounded-xl p-3.5 bg-slate-800/70 border border-slate-700/60 space-y-3">
      <div className="flex items-start gap-3">
        <span className="w-8 h-8 rounded-lg bg-orange-500/15 flex items-center justify-center flex-shrink-0">
          <Star size={16} className="text-orange-400"/>
        </span>
        <div className="flex-1 min-w-0 space-y-1">
          <p className="text-sm font-medium text-slate-100">{t("app.review.title")}</p>
          <p className="text-xs text-slate-300 leading-relaxed">{t(isIos ? "app.review.bodyIos" : "app.review.bodyAndroid")}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pl-11">
        <button onClick={() => onAnswer("review")}
          className="bg-orange-500 hover:bg-orange-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors">
          {t("app.review.cta")}
        </button>
        <button onClick={() => onAnswer("later")}
          className="bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors">
          {t("app.review.later")}
        </button>
        {ask > 1 && (
          <button onClick={() => onAnswer("never")}
            className="text-slate-400 hover:text-slate-200 text-xs font-medium px-2 py-1.5 transition-colors">
            {t("app.review.never")}
          </button>
        )}
      </div>
    </div>
  );
}
