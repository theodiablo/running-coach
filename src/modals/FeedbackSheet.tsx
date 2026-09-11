import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquare, X } from "lucide-react";
import { useDismissable } from "../hooks/useDismissable";
import { track } from "../telemetry";
import { platform, nativeBuildLabel } from "../native";
import { submitBetaFeedback, MAX_FEEDBACK_LEN, type FeedbackSource } from "../betaFeedback";

type Props = {
  source: FeedbackSource;
  /** False the first time this account opens it — shows the explainer. */
  introSeen: boolean;
  onIntroSeen: () => void;
  onSent: () => void;
  onClose: () => void;
  showToast: (msg: string) => void;
};

// The beta feedback sheet: explainer (first open only) → compose → send.
// Reached from three doors (the floating pill, the coach chat header, the
// settings hub) — they differ only in the `source` they pass, which names the
// screen in the context block and in the row we store.
//
// z-[60] because it must open ABOVE the coach chat's own z-50: the coach is
// exactly the surface people have opinions about, so its header carries one of
// the three doors and the sheet has to clear it.
export function FeedbackSheet({ source, introSeen, onIntroSeen, onSent, onClose, showToast }: Props) {
  const { t } = useTranslation();
  const [showIntro, setShowIntro] = useState(!introSeen);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useDismissable(true, onClose);

  const leaveIntro = () => {
    setShowIntro(false);
    onIntroSeen();
  };

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await submitBetaFeedback({ body, source });
      track("feedback_sent", { source });
      showToast(t("feedback.sent"));
      onSent();
      onClose();
    } catch {
      showToast(t("feedback.error"));
      setBusy(false);
    }
  };

  const build = nativeBuildLabel();

  return (
    <div className="fixed inset-0 z-[60] flex flex-col justify-end">
      <button aria-label={t("common.close")} onClick={onClose}
        className="absolute inset-0 bg-black/70 animate-overlay-fade"/>
      <div className="relative bg-slate-800 border-t border-slate-700 rounded-t-[20px] animate-slide-up w-full max-w-lg mx-auto"
        style={{ maxHeight: "82%", paddingBottom: "var(--safe-bottom)" }}>
        <div className="mx-auto mt-2.5 mb-1 h-1 w-8 rounded-full bg-slate-600" aria-hidden/>

        {showIntro ? (
          <div className="px-4 pb-4 pt-1 overflow-y-auto">
            <span className="inline-block text-[10px] font-bold uppercase tracking-wide bg-orange-500/20 text-orange-300 px-1.5 py-0.5 rounded">
              {t("feedback.badge")}
            </span>
            <h2 className="text-base font-semibold mt-2">{t("feedback.intro.title")}</h2>
            <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">{t("feedback.intro.body")}</p>
            <button onClick={leaveIntro}
              className="w-full mt-4 py-2.5 rounded-xl text-sm font-semibold bg-orange-500 hover:bg-orange-600 text-white transition-colors">
              {t("feedback.intro.start")}
            </button>
          </div>
        ) : (
          <div className="px-4 pb-4 pt-1 overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">{t("feedback.compose.title")}</h2>
              <button onClick={onClose} aria-label={t("common.close")}
                className="text-slate-400 hover:text-white p-1"><X size={16}/></button>
            </div>

            <textarea id="beta-feedback" name="beta-feedback" value={text} autoFocus
              onChange={e => setText(e.target.value.slice(0, MAX_FEEDBACK_LEN))}
              placeholder={t("feedback.compose.placeholder")} rows={5}
              aria-label={t("feedback.aria")}
              className="w-full mt-2 bg-slate-900/60 border border-slate-700 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-orange-400 placeholder-slate-500 resize-none"/>


            <p className="text-[10px] uppercase tracking-wide text-slate-500 mt-3">{t("feedback.compose.contextTitle")}</p>
            <div className="mt-1.5 bg-slate-900/60 border border-slate-700 rounded-xl p-3 space-y-1">
              <p className="text-[11px] text-slate-400">{t("feedback.source." + source)}</p>
              <p className="text-[11px] text-slate-400">{[build, platform].filter(Boolean).join(" · ")}</p>
              <p className="text-[11px] text-slate-400">{t("feedback.compose.contextAccount")}</p>
            </div>

            <button onClick={send} disabled={busy || !text.trim()}
              className="w-full mt-4 bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-white py-2.5 rounded-xl text-sm font-semibold transition-colors">
              {t("feedback.compose.send")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// The floating pill. Rendered as a SIBLING of BottomNav in RunningCoach, never
// inside it — BottomNav is presentational and the marketing mockup renders it
// too. z-30 clears the z-20 nav and stays under the z-50 full-screen sheets,
// which carry their own entry point instead.
export function FeedbackButton({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button onClick={onClick} aria-label={t("feedback.aria")}
      className="fixed right-3 z-30 flex items-center gap-1.5 rounded-full bg-slate-800 border border-orange-500/55 text-orange-300 shadow-lg px-3 py-2 text-[11px] font-semibold active:scale-95 transition-transform"
      style={{ bottom: "calc(64px + var(--safe-bottom) + 12px)" }}>
      <MessageSquare size={13}/>
      {!collapsed && t("feedback.button")}
    </button>
  );
}
