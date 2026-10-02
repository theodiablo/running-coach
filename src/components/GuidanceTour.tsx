import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useDismissable } from "../hooks/useDismissable";

// First-time walk-through of the recorder's workout + audio rows. Rendered
// INSIDE the tracker's stacking context: the dimmer sits above the map, and the
// spotlighted row lifts itself above the dimmer (SPOTLIGHT_CLS), so the row
// being explained stays lit and tappable.
export const SPOTLIGHT_CLS = "relative z-[1150] ring-2 ring-orange-500 shadow-[0_0_24px_rgba(249,115,22,0.55)]";

export type TourStep = { target: RefObject<HTMLElement | null>; title: string; body: ReactNode };

export function GuidanceTour({ steps, index, onNext, onDone }: {
  steps: TourStep[];
  index: number;
  onNext: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  useDismissable(true, onDone);
  const tipRef = useRef<HTMLDivElement>(null);
  const step = steps[index];
  const last = index >= steps.length - 1;

  // Pin the bubble just above its row; written straight to the DOM so layout
  // never round-trips through state.
  useLayoutEffect(() => {
    const place = () => {
      const el = step?.target.current;
      const tip = tipRef.current;
      if (!el || !tip) return;
      el.scrollIntoView?.({ block: "nearest" });
      // Relative to the tip's containing block: the recorder slides in with a
      // transform, which makes it (not the viewport) what `fixed` resolves to.
      const box = tip.parentElement?.getBoundingClientRect();
      tip.style.bottom = `${(box ? box.bottom : window.innerHeight) - el.getBoundingClientRect().top + 12}px`;
      tip.style.visibility = "visible";
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [step]);

  if (!step) return null;
  return (
    <>
      <div className="fixed inset-0 z-[1100] bg-slate-950/75 animate-overlay-fade" aria-hidden />
      <div ref={tipRef} role="dialog" aria-label={step.title} style={{ visibility: "hidden" }}
        className="fixed left-3 right-3 z-[1200] rounded-2xl bg-orange-50 p-3.5 text-orange-950 shadow-xl space-y-2 animate-pop">
        <p className="text-sm font-bold">{step.title}</p>
        <div className="text-xs leading-relaxed">{step.body}</div>
        <div className="flex items-center gap-2 pt-1">
          <span className="flex flex-1 gap-1" aria-hidden>
            {steps.map((_, i) => <span key={i} className={"h-1.5 w-1.5 rounded-full " + (i === index ? "bg-orange-600" : "bg-orange-300")} />)}
          </span>
          {!last && <button onClick={onDone} className="px-2 py-1.5 text-xs font-semibold text-orange-800">{t("tracker.tour.skip")}</button>}
          <button onClick={last ? onDone : onNext}
            className="rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white">
            {last ? t("common.gotIt") : t("tracker.tour.next")}
          </button>
        </div>
        <span className="absolute -bottom-1.5 left-10 h-3 w-3 rotate-45 bg-orange-50" aria-hidden />
      </div>
    </>
  );
}
