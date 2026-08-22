import type { ReactNode } from "react";

// Shared filter chip, used with BANDS/RADII (src/hooks/useNearMeFilter.ts) by
// the Races tab's Find panel and the onboarding race picker.
type ChipProps = { active: boolean; onClick: () => void; children: ReactNode };

export function Chip({ active, onClick, children }: ChipProps) {
  return (
    <button onClick={onClick}
      className={"px-3 py-1 rounded-full text-xs font-semibold transition-colors border " +
        (active ? "bg-orange-500 text-white border-orange-500" : "bg-slate-800 text-slate-300 border-slate-700 hover:border-slate-500")}>
      {children}
    </button>
  );
}
