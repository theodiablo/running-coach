import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useDismissable } from "../hooks/useDismissable";

// One-time pointer at a fixed control (position prop: header Coach pill or feedback pill).
// The dimmer is BELOW the header's z-20 so the pointed-at control stays lit and tappable.
// Bottom nav shares z-20, so a tab tap unmounts this without `onDismiss`: `RunningCoach`
// spends the flag on leaving the anchor's screen.
type CoachmarkAnchor = "header" | "feedback";

type CoachmarkProps = {
  title: string;
  body: string;
  cta: string;
  onDismiss: () => void;
  /** Which fixed control this points at. Defaults to the header Coach pill. */
  anchor?: CoachmarkAnchor;
};

export function Coachmark({ title, body, cta, onDismiss, anchor = "header" }: CoachmarkProps) {
  const { t } = useTranslation();
  useDismissable(true, onDismiss);
  return (
    <>
      {/* Redundant with the close button for anyone who can see the dimmer, so
          it stays out of the accessibility tree rather than announcing a second
          identical "Dismiss". */}
      <button aria-hidden tabIndex={-1} onClick={onDismiss}
        className="fixed inset-0 z-10 w-full h-full bg-slate-950/60 cursor-default"/>
      <div role="dialog" aria-label={title}
        className="fixed right-3 z-40 w-60 bg-slate-800 border border-orange-500/40 rounded-2xl p-3.5 shadow-xl shadow-slate-950/50 animate-pop"
        style={anchor === "header"
          ? {top: "calc(52px + var(--safe-top))"}
          : {bottom: "calc(64px + var(--safe-bottom) + 56px)"}}>
        {/* The arrow, against whichever control this points at. */}
        {anchor === "header" ? (
          <div className="absolute -top-1.5 right-[78px] w-3 h-3 rotate-45 bg-slate-800 border-l border-t border-orange-500/40"/>
        ) : (
          <div className="absolute -bottom-1.5 right-6 w-3 h-3 rotate-45 bg-slate-800 border-r border-b border-orange-500/40"/>
        )}
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
