import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDismissable } from "../hooks/useDismissable";
import {
  usageLeft, usageFraction, usageTone, USAGE_COLORS, type CoachUsage,
} from "../utils/coachUsage";

// The ring's grey track. Deliberately lighter than the old #26334a: at 0 used
// the colour arc is 0°, so the track alone must stay visible against the
// footer's #0f172a or a fresh day shows nothing at all.
const TRACK = "#48566b";

// Placeholder shown in the ring's slot while the usage fetch is in flight —
// same 18px footprint so the real ring pops in without a layout shift.
// Decorative only (the fetch may still resolve to "hide the ring").
export function CoachUsageRingSkeleton() {
  return (
    <div className="relative rounded-full shrink-0 animate-pulse" aria-hidden="true"
      style={{ width: 18, height: 18, background: TRACK }}>
      <span className="absolute rounded-full" style={{ inset: 4, background: "#0f172a" }} />
    </div>
  );
}

// Daily-usage donut ring at the bottom-right of the coach footer, plus a tap popover with
// a usage breakdown. Slate while budget is plentiful, a coloured "N left today" as it
// fills, red "resets tomorrow" at the limit. `usage === null` is the caller's concern.
// Mounts once when the fetch replaces the skeleton, so `animate-pop` fires then.
export function CoachUsageRing({ usage }: { usage: CoachUsage }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  useDismissable(open, () => setOpen(false));

  const tone = usageTone(usage);
  const fraction = usageFraction(usage);
  const left = usageLeft(usage);
  const color = USAGE_COLORS[tone];
  const deg = Math.round(fraction * 360);

  // No label while there's comfortable budget left — the ring alone is enough.
  const label = tone === "exhausted"
    ? t("coach.usage.resets")
    : tone === "normal"
      ? null
      : t("coach.usage.left", { left });

  return (
    <div className="relative flex items-center gap-1.5 animate-pop">
      {label && <span className="text-[11px] font-medium" style={{ color }}>{label}</span>}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label={t("coach.usage.ringAria", { used: usage.used, limit: usage.limit })}
        aria-expanded={open}
        className="relative rounded-full shrink-0"
        style={{ width: 18, height: 18, background: `conic-gradient(${color} ${deg}deg, ${TRACK} ${deg}deg)` }}
      >
        <span className="absolute rounded-full" style={{ inset: 4, background: "#0f172a" }} />
      </button>

      {open && (
        <>
          {/* transparent catcher: outside-tap closes the popover (Escape/back is
              handled by useDismissable above). */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label={t("coach.usage.detail.title")}
            className="absolute bottom-full right-0 mb-2 z-20 w-60 rounded-xl border border-slate-700 bg-slate-800 p-3 shadow-xl animate-slide-up"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-semibold text-slate-100">{t("coach.usage.detail.title")}</span>
              <span className="text-[11px] text-slate-500">{t("coach.usage.detail.resets")}</span>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-slate-700 overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${Math.round(fraction * 100)}%`, background: color }} />
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px]">
              <span className="text-slate-400">{t("coach.usage.detail.dailyRequests")}</span>
              <span className="text-slate-300 font-medium">{t("coach.usage.detail.used", { used: usage.used, limit: usage.limit })}</span>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{t("coach.usage.detail.freeActions")}</p>
          </div>
        </>
      )}
    </div>
  );
}
