import { Medal } from "lucide-react";

// Presentational only: the auto-dismiss timer lives in the parent. `action` renders an inline button (e.g. Undo);
// `closing` (parent's usePresence) swaps in the exit animation; `type === "badge"` is the celebratory unlock variant.
type ToastAction = { label: string; onClick: () => void };

export function Toast({msg, type, action, closing}: { msg: string; type: string; action?: ToastAction; closing?: boolean }) {
  const isBadge = type === "badge";
  const pill =
    type === "err" ? "bg-red-500"
    : isBadge ? "bg-slate-800 border border-orange-500/40"
    : "bg-emerald-500";
  return (
    <div className={"fixed left-4 right-4 max-w-md mx-auto z-[2100] " + (closing ? "animate-toast-out" : "animate-toast-in")} style={{top:"calc(52px + var(--safe-top))"}}>
      <div className={"py-2.5 px-4 rounded-xl text-sm font-medium shadow-lg text-white flex items-center justify-center gap-3 " + pill}>
        {isBadge && <Medal size={16} className="flex-shrink-0 text-orange-400 animate-pop"/>}
        <span>{msg}</span>
        {action && (
          <button onClick={action.onClick}
            className="flex-shrink-0 underline underline-offset-2 font-semibold hover:opacity-80">
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}
