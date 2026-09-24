// The watch page's pitch for the app: store buttons, the feature list, the
// in-run row and the About sheet. Only ever rendered on the public page.
import { useTranslation } from "react-i18next";
import { CalendarDays, ExternalLink, MapPin, MessageCircle, X } from "lucide-react";
import { BrandLogo } from "../components/BrandLogo";
import { useDismissable } from "../hooks/useDismissable";
import { iosBetaLink, playStoreLink, siteLink, type PromoPlacement, type VisitorPlatform } from "./storeLinks";

const NAVY = "text-[#0b1220]";
const APPLE_PATH = "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701";
const PLAY_PATH = "M22.018 13.298l-3.919 2.218-3.515-3.493 3.543-3.521 3.891 2.202a1.49 1.49 0 0 1 0 2.594zM1.337.924a1.486 1.486 0 0 0-.112.568v21.017c0 .217.045.419.124.6l11.155-11.087L1.337.924zm12.207 10.065l3.258-3.238L3.45.195a1.466 1.466 0 0 0-.946-.179l11.04 10.973zm0 2.067l-11 10.933c.298.036.612-.016.906-.183l13.324-7.54-3.23-3.21z";

const external = { target: "_blank", rel: "noopener noreferrer" } as const;

// "iPhone", not "App Store": the button leads to TestFlight, and Apple reserves
// its store name and badge for real listings. Swap in the badge once one exists.
function StoreButton({ store, placement, primary, compact }: {
  store: "play" | "ios"; placement: PromoPlacement; primary: boolean; compact?: boolean;
}) {
  const { t } = useTranslation();
  const ios = store === "ios";
  const size = compact ? 22 : 26;
  return (
    <div className="relative flex flex-col">
      <a href={ios ? iosBetaLink() : playStoreLink(placement)} {...external}
        aria-label={t(ios ? "liveShare.public.store.iosAria" : "liveShare.public.store.playAria")}
        className={`flex items-center justify-center gap-2.5 rounded-2xl ${NAVY} transition-colors
          ${compact ? "min-h-[50px] px-3 py-1.5" : "min-h-14 px-4 py-2"}
          ${primary ? "bg-orange-500 hover:bg-orange-400" : "bg-slate-100 hover:bg-white"}`}>
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden className="shrink-0">
          <path d={ios ? APPLE_PATH : PLAY_PATH} />
        </svg>
        <span className="flex flex-col items-start leading-none" aria-hidden>
          <span className={`${compact ? "text-[10px]" : "text-[11px]"} font-semibold uppercase tracking-wide`}>
            {t("liveShare.public.store.getItOn")}
          </span>
          <span className={`${compact ? "text-base" : "text-lg"} font-extrabold tracking-tight mt-0.5`}>
            {ios ? "iPhone" : "Google Play"}
          </span>
        </span>
      </a>
      {ios && (
        <span aria-hidden className={`pointer-events-none absolute top-[5px] right-2 rotate-[4deg] rounded-full bg-yellow-300 ${NAVY}
          px-1.5 py-[3px] text-[9px] font-extrabold uppercase tracking-wide whitespace-nowrap shadow-[0_2px_0_rgba(2,6,23,0.45)]`}>
          {t("liveShare.public.store.betaSticker")}
        </span>
      )}
    </div>
  );
}

// The visitor's own store first, in orange; the other one light underneath.
export function StoreButtons({ platform, placement, compact }: {
  platform: VisitorPlatform; placement: PromoPlacement; compact?: boolean;
}) {
  const { t } = useTranslation();
  if (platform === "ios") {
    return (
      <div className="flex flex-col gap-2.5">
        <StoreButton store="ios" placement={placement} primary compact={compact} />
        <p className="text-center text-xs text-slate-400">{t("liveShare.public.store.iosNote")}</p>
        <StoreButton store="play" placement={placement} primary={false} compact={compact} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2.5">
      <StoreButton store="play" placement={placement} primary compact={compact} />
      <StoreButton store="ios" placement={placement} primary={false} compact={compact} />
    </div>
  );
}

export function AppFeatures() {
  const { t } = useTranslation();
  const rows = [
    { Icon: CalendarDays, text: t("liveShare.public.features.plan") },
    { Icon: MapPin, text: t("liveShare.public.features.gps") },
    { Icon: MessageCircle, text: t("liveShare.public.features.coach") },
  ];
  return (
    <ul className="space-y-3">
      {rows.map(({ Icon, text }) => (
        <li key={text} className="flex items-center gap-3 text-sm text-slate-300 leading-snug">
          <span className="shrink-0 grid place-items-center w-8 h-8 rounded-[10px] bg-orange-500/10 text-orange-400">
            <Icon size={16} aria-hidden />
          </span>
          {text}
        </li>
      ))}
    </ul>
  );
}

export function AppMark({ size = 40 }: { size?: number }) {
  return (
    <span className={`shrink-0 grid place-items-center rounded-xl bg-orange-500 ${NAVY}`} style={{ width: size, height: size }}>
      <BrandLogo size={Math.round(size * 0.3)} />
    </span>
  );
}

export function SiteLink({ placement, label }: { placement: PromoPlacement; label: string }) {
  return (
    <a href={siteLink(placement)} {...external}
      className="self-center inline-flex items-center gap-1.5 min-h-8 text-[13px] text-slate-400 hover:text-slate-200">
      {label} <ExternalLink size={13} aria-hidden />
    </a>
  );
}

// The desktop side panel has room for the store buttons themselves.
export function LivePromo({ platform }: { platform: VisitorPlatform }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-2xl bg-[#111c33] border border-slate-800 p-3.5 space-y-3">
      <div className="flex items-center gap-3">
        <AppMark />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold">Running Coach</p>
          <p className="text-xs text-slate-400 leading-snug">{t("liveShare.public.rowBody")}</p>
        </div>
      </div>
      <StoreButtons platform={platform} placement="live" compact />
    </div>
  );
}

// Phones: pinned under the map and stats rather than at the foot of their
// scrolling panel, so it stays on screen for the whole run.
export function PinnedPromo({ ended, onAbout }: { ended: boolean; onAbout: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 px-4 pt-2.5 border-t border-slate-800 bg-[#111c33]"
      style={{ paddingBottom: "calc(0.625rem + var(--safe-bottom))" }}>
      <AppMark size={36} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold leading-tight">{ended ? t("liveShare.public.endedTitle") : "Running Coach"}</p>
        <p className="text-xs text-slate-400 leading-snug truncate">{t("liveShare.public.rowBody")}</p>
      </div>
      <button onClick={onAbout}
        className="shrink-0 min-h-10 px-3.5 rounded-xl bg-orange-500 hover:bg-orange-400 text-[#0b1220] text-[13px] font-bold">
        {t("liveShare.public.rowCta")}
      </button>
    </div>
  );
}

// Once the run is over the viewer is free to look elsewhere, so the pitch grows.
export function EndedPromo({ platform }: { platform: VisitorPlatform }) {
  const { t } = useTranslation();
  return (
    <section className="rounded-[20px] bg-[#111c33] border border-orange-500/35 p-4 space-y-3.5">
      <div className="flex items-center gap-3">
        <AppMark size={44} />
        <div>
          <h2 className="text-[17px] font-extrabold leading-tight">{t("liveShare.public.endedTitle")}</h2>
          <p className="mt-0.5 text-[13px] text-slate-400 leading-snug">{t("liveShare.public.endedBody")}</p>
        </div>
      </div>
      <StoreButtons platform={platform} placement="ended" compact />
    </section>
  );
}

export function AboutSheet({ platform, onClose }: { platform: VisitorPlatform; onClose: () => void }) {
  const { t } = useTranslation();
  useDismissable(true, onClose);
  return (
    <div className="fixed inset-0 z-[2000] flex items-end md:items-center justify-center bg-black/70 animate-overlay-fade"
      onClick={onClose}>
      <section role="dialog" aria-modal="true" aria-label={t("liveShare.public.aboutTitle")}
        onClick={e => e.stopPropagation()}
        className="w-full md:max-w-md max-h-full overflow-y-auto bg-[#111c33] border-t md:border border-slate-700
          rounded-t-3xl md:rounded-3xl px-5 pt-2.5 md:pt-5 flex flex-col gap-4 animate-scale-in"
        style={{ paddingBottom: "calc(1.5rem + var(--safe-bottom))" }}>
        <div className="md:hidden self-center w-10 h-1 rounded-full bg-slate-700" aria-hidden />
        <div className="flex items-center gap-3">
          <AppMark size={48} />
          <div className="flex-1">
            <h2 className="text-[19px] font-extrabold">Running Coach</h2>
            <p className="text-[13px] text-slate-400">{t("liveShare.public.sheetSubtitle")}</p>
          </div>
          <button onClick={onClose} aria-label={t("liveShare.public.close")}
            className="shrink-0 grid place-items-center w-11 h-11 rounded-full bg-slate-800 text-slate-400 hover:text-slate-200">
            <X size={18} />
          </button>
        </div>
        <p className="text-sm leading-relaxed text-slate-300">{t("liveShare.public.sheetBody")}</p>
        <AppFeatures />
        <StoreButtons platform={platform} placement="sheet" />
        <SiteLink placement="sheet" label={t("liveShare.public.website")} />
      </section>
    </div>
  );
}
