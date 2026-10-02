import { forwardRef, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

// One row of the recorder's settings list: icon, name, one line of state, and
// a sheet behind it. `trailing` replaces the chevron (live sharing keeps its
// switch on the row; the switch must stop its own click from opening the sheet).
type RecorderOptionRowProps = {
  icon: ReactNode;
  title: string;
  status: string;
  tone?: "off" | "on" | "live" | "info";
  onOpen: () => void;
  trailing?: ReactNode;
  className?: string;
};

const TONE = { off: "text-slate-400", on: "text-orange-300", live: "text-emerald-300", info: "text-sky-300" };

export const RecorderOptionRow = forwardRef<HTMLDivElement, RecorderOptionRowProps>(
  function RecorderOptionRow({ icon, title, status, tone = "off", onOpen, trailing, className = "" }, ref) {
    return (
      <div ref={ref} role="button" tabIndex={0} onClick={onOpen}
        onKeyDown={e => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(); } }}
        className={"flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-700/40 " + className}>
        <span className="flex w-5 shrink-0 justify-center">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-100">{title}</span>
          <span className={"block truncate text-xs " + TONE[tone]}>{status}</span>
        </span>
        {trailing ?? <ChevronRight size={16} className="shrink-0 text-slate-500" />}
      </div>
    );
  });
