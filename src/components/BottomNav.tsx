import { Activity, Calendar, Trophy, TrendingUp, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

// The app's bottom navigation: four row tabs (Home, Plan, Races, Progress) with a
// raised center Record FAB. Extracted so the marketing mockup renders the real nav.
// Presentational only: the caller owns positioning (`className`) and handlers; omit
// the handlers to render a static, decorative preview.

const NAV_TABS = [
  { id: "dash", labelKey: "nav.home", Icon: Activity },
  { id: "plan", labelKey: "nav.plan", Icon: Calendar },
  { id: "races", labelKey: "nav.races", Icon: Trophy },
  { id: "progress", labelKey: "nav.progress", Icon: TrendingUp },
] as const;

type NavItem = { id: string; labelKey: string; Icon: React.ComponentType<{ size?: number }> };

function NavBtn({ item, active, onClick }: { item: NavItem; active: boolean; onClick?: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClick}
      className={
        "relative flex-1 flex flex-col items-center justify-center gap-0.5 text-xs transition-[color,transform] active:scale-95 " +
        (active ? "text-orange-400" : "text-slate-400 hover:text-slate-200")
      }
    >
      {active && (
        <span aria-hidden className="absolute top-0 h-0.5 w-8 rounded-full bg-orange-400 animate-scale-in" />
      )}
      <item.Icon size={20} />
      {t(item.labelKey)}
    </button>
  );
}

type BottomNavProps = {
  /** id of the active tab (matches NAV_TABS ids; e.g. "dash"). */
  active: string;
  /** Positioning/utility classes — e.g. "fixed bottom-0 inset-x-0 z-20" in the
   *  app, "absolute bottom-0 inset-x-0" inside the marketing phone frame. */
  className?: string;
  onTab?: (id: string) => void;
  onRecord?: () => void;
  /** Progress opens the stats sub-view specifically; falls back to onTab. */
  onProgress?: () => void;
};

export function BottomNav({ active, className = "", onTab, onRecord, onProgress }: BottomNavProps) {
  const { t } = useTranslation();
  const select = (id: string) => {
    if (id === "progress" && onProgress) return onProgress();
    onTab?.(id);
  };
  return (
    <nav
      className={"bg-slate-800 border-t border-slate-700 flex items-stretch " + className}
      // Grow past the 64px bar height by the iOS home-indicator inset and pad
      // the buttons up off it (0 on web/Android). Marketing renders a static
      // preview and no longer mounts this, so the inset never affects the mock.
      style={{ height: "calc(64px + var(--safe-bottom))", paddingBottom: "var(--safe-bottom)" }}
    >
      {NAV_TABS.slice(0, 2).map((item) => (
        <NavBtn key={item.id} item={item} active={active === item.id} onClick={() => select(item.id)} />
      ))}
      {/* Center Record FAB — raised above the bar. */}
      <div className="flex-1 flex items-center justify-center">
        <button
          onClick={onRecord}
          aria-label={t("nav.record")}
          className="flex items-center justify-center bg-orange-500 hover:bg-orange-600 text-white rounded-full shadow-lg transition-[background-color,transform] active:scale-90"
          style={{ width: 54, height: 54, marginTop: -18 }}
        >
          <Plus size={26} />
        </button>
      </div>
      {NAV_TABS.slice(2).map((item) => (
        <NavBtn key={item.id} item={item} active={active === item.id} onClick={() => select(item.id)} />
      ))}
    </nav>
  );
}
