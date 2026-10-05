import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useDismissable } from "../hooks/useDismissable";

// The bottom sheet every recorder setting opens into (today's run, audio
// guidance, live sharing). Above the tracker and its map, below ModalOverlay so
// a confirm raised from inside a sheet still lands on top.
export function RecorderSheet({ title, badge, headerRight, onClose, children }: {
  title: string;
  badge?: ReactNode;
  headerRight?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  useDismissable(true, onClose);
  return (
    <div className="fixed inset-0 z-[1500] flex items-end bg-black/60 animate-overlay-fade" onClick={onClose}>
      <div role="dialog" aria-label={title} onClick={e => e.stopPropagation()}
        className="w-full max-h-[90%] flex flex-col bg-slate-800 border-t border-slate-700 rounded-t-2xl animate-slide-up"
        style={{ paddingBottom: "calc(1rem + var(--safe-bottom))" }}>
        <div className="px-4 pt-2.5 pb-2 space-y-2">
          <div className="w-9 h-1 rounded-full bg-slate-600 mx-auto" />
          <div className="flex items-center gap-3">
            <h3 className="flex flex-1 items-center gap-2 text-base font-bold text-white">{title}{badge}</h3>
            {headerRight}
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 space-y-3">{children}</div>
        <div className="px-4 pt-3">
          <button onClick={onClose}
            className="w-full bg-orange-500 hover:bg-orange-600 text-white py-3 rounded-xl text-sm font-semibold">
            {t("common.done")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Segmented single choice, the sheets' one picker shape. */
export function Segmented<T extends string | number>({ value, options, onChange, label, disabled }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label}
      className={"grid grid-flow-col auto-cols-fr gap-1 p-1 rounded-xl bg-slate-900 " + (disabled ? "opacity-50" : "")}>
      {options.map(o => (
        <button key={String(o.value)} role="radio" aria-checked={o.value === value} disabled={disabled}
          onClick={() => onChange(o.value)}
          className={"py-1.5 px-1 rounded-lg text-xs font-semibold transition-colors "
            + (o.value === value ? "bg-orange-500 text-white" : "text-slate-400 hover:text-slate-200")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** − value + row; `onStep` gets ±1. */
export function Stepper({ name, value, onStep, muted, children }: {
  name: string;
  value: ReactNode;
  onStep: (dir: 1 | -1) => void;
  muted?: boolean;
  /** Extra control under the name (a unit switch). */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 rounded-xl bg-slate-900 pl-3 pr-1.5 py-1.5">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-300">{name}</p>
        {children}
      </div>
      <button onClick={() => onStep(-1)} aria-label={t("tracker.setup.decrease", { name })}
        className="w-9 h-9 rounded-lg bg-slate-800 hover:bg-slate-700 text-lg text-slate-100">−</button>
      <span className={"min-w-[88px] text-center text-sm tabular-nums " + (muted ? "text-slate-500" : "font-semibold text-white")}>{value}</span>
      <button onClick={() => onStep(1)} aria-label={t("tracker.setup.increase", { name })}
        className="w-9 h-9 rounded-lg bg-slate-800 hover:bg-slate-700 text-lg text-slate-100">+</button>
    </div>
  );
}

export function SheetLabel({ children }: { children: ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 pt-1">{children}</p>;
}
