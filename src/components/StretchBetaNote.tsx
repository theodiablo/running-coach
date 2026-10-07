import { useTranslation } from "react-i18next";
import { MessageSquare } from "lucide-react";

/** Stretching is a beta: says so, and opens the feedback sheet tagged with it. */
export function StretchBetaNote({ onFeedback, compact = false }: { onFeedback?: () => void; compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2.5 space-y-2 text-left">
      <p className="text-xs text-amber-200 leading-relaxed">{t(compact ? "stretch.beta.done" : "stretch.beta.note")}</p>
      {onFeedback && (
        <button onClick={onFeedback}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-100 bg-amber-400/15 hover:bg-amber-400/25 rounded-lg px-2.5 py-1.5 transition-colors">
          <MessageSquare size={13}/>{t("stretch.beta.send")}
        </button>
      )}
    </div>
  );
}
