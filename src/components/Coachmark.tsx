import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useDismissable } from "../hooks/useDismissable";

// A one-time pointer at a header control: a dimmer plus a bubble whose arrow
// sits under the anchor. The app's only coachmark — if a second one is ever
// needed, generalise this rather than rolling another overlay.
//
// The dimmer is deliberately BELOW the header's z-20 (the bubble is above it),
// so the control being pointed at stays lit and still works — tapping it is a
// perfectly good way to answer a pointer that says "your coach lives here".
//
// Dismissing is the ONLY exit (there is no timeout): the dimmer, the close
// button, the CTA, and Android back / Escape via useDismissable all run
// `onDismiss`, whose caller is expected to persist "seen" — a pointer that can
// reappear is worse than one that was never shown.
type CoachmarkProps = {
  title: string;
  body: string;
  cta: string;
  onDismiss: () => void;
};

export function Coachmark({ title, body, cta, onDismiss }: CoachmarkProps) {
  const { t } = useTranslation();
  useDismissable(true, onDismiss);
  return (
    <>
      <button aria-label={t("app.coachmark.dismiss")} onClick={onDismiss}
        className="fixed inset-0 z-10 w-full h-full bg-slate-950/60 cursor-default"/>
      <div role="dialog" aria-label={title}
        className="fixed right-3 z-30 w-60 bg-slate-800 border border-orange-500/40 rounded-2xl p-3.5 shadow-xl shadow-slate-950/50 animate-pop"
        style={{top: "calc(52px + var(--safe-top))"}}>
        {/* The arrow, pointed at the header's Coach pill. */}
        <div className="absolute -top-1.5 right-[78px] w-3 h-3 rotate-45 bg-slate-800 border-l border-t border-orange-500/40"/>
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-slate-100">{title}</p>
          <button onClick={onDismiss} aria-label={t("app.coachmark.dismiss")}
            className="-mr-1 -mt-0.5 p-1 text-slate-500 hover:text-slate-200 transition-colors">
            <X size={14}/>
          </button>
        </div>
        <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">{body}</p>
        <button onClick={onDismiss}
          className="mt-3 bg-orange-500 hover:bg-orange-600 text-white px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors">
          {cta}
        </button>
      </div>
    </>
  );
}
