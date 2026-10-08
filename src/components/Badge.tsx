import { Footprints, Medal, Trophy, Gauge, CalendarCheck, CalendarHeart,
  Star, Flag, MapPin, Mountain, PersonStanding, Sparkles, Award } from "lucide-react";
import type { ComponentType } from "react";

// Lucide icons referenced by name from src/utils/badges.ts (kept React-free).
const ICONS = { Footprints, Medal, Trophy, Gauge, CalendarCheck, CalendarHeart,
  Star, Flag, MapPin, Mountain, PersonStanding, Sparkles };

type BadgeIconName = keyof typeof ICONS;
type BadgeData = {
  Icon: string;
  unlocked: boolean;
  label: string;
  desc: string;
  progress: number;
  hint?: string | null;
};

type BadgeProps = { badge: BadgeData };

// One badge: unlocked = orange accent + icon; locked = greyed with a thin
// progress bar + remaining-amount hint, so it reads as "almost there", not
// "you failed".
export function Badge({ badge }: BadgeProps) {
  const Icon: ComponentType<{ size?: number; className?: string }> = ICONS[badge.Icon as BadgeIconName] || Award;
  const u = badge.unlocked;
  return (
    <div className={"rounded-xl p-3 border flex flex-col items-center text-center gap-1.5 " +
      (u ? "border-orange-500/40 bg-orange-500/10" : "border-slate-700 bg-slate-800")}>
      <Icon size={24} className={u ? "text-orange-400" : "text-slate-600"}/>
      <p className={"text-xs font-semibold leading-tight " + (u ? "text-white" : "text-slate-400")}>{badge.label}</p>
      <p className="text-[10px] text-slate-500 leading-tight">{badge.desc}</p>
      {!u && (
        <>
          <div className="w-full h-1 bg-slate-700 rounded-full overflow-hidden mt-0.5">
            <div className="h-full bg-slate-500 rounded-full transition-[width] duration-500" style={{width: Math.round(badge.progress * 100) + "%"}}/>
          </div>
          {badge.hint && <p className="text-[10px] text-slate-500">{badge.hint}</p>}
        </>
      )}
    </div>
  );
}
