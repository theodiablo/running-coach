import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useDismissable } from "../hooks/useDismissable";
import { ModalOverlay, ConfirmButtons } from "./ModalPrimitives";

// The parts both recorders (LiveRunTracker, IndoorTracker) render identically.
// They stay separate screens on purpose — see IndoorTracker's header comment —
// but these three are the same control, and a change to one has to reach both.

// Large, glove-friendly control button.
export function Ctrl({ onClick, color, children, disabled = false }: {
  onClick: () => void; color: string; children: ReactNode; disabled?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={"flex-1 flex items-center justify-center gap-2 py-4 rounded-2xl text-base font-semibold transition-[background-color,transform] active:scale-95 disabled:opacity-50 disabled:active:scale-100 " + color}>
      {children}
    </button>
  );
}

// Pre-start countdown. Tapping anywhere cancels; the digit remounts per tick
// (via `key`) so the animation re-fires.
export function CountdownOverlay({ count, onCancel }: { count: number; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" onClick={onCancel} aria-label={t("common.cancel")}
      className="absolute inset-0 z-[1100] flex items-center justify-center bg-slate-900/85">
      <span key={count} aria-live="assertive"
        className="text-8xl font-extrabold text-orange-400 tabular-nums animate-countdown">
        {count > 0 ? count : t("tracker.countdown.go")}
      </span>
    </button>
  );
}

// Throwing away a recording. In the DOM, never window.confirm (see CLAUDE.md):
// the Android back gesture routes here, and a native dialog raised as the
// activity backgrounds never answers.
export function DiscardConfirm({ message, onCancel, onAccept }: {
  message: string; onCancel: () => void; onAccept: () => void;
}) {
  const { t } = useTranslation();
  useDismissable(true, onCancel);
  return (
    <ModalOverlay>
      <div className="bg-slate-800 rounded-2xl w-full max-w-sm border border-slate-700 p-4 space-y-3">
        <p className="text-sm text-slate-200">{message}</p>
        <ConfirmButtons cancelLabel={t("common.cancel")} acceptLabel={t("tracker.controls.discard")}
          onCancel={onCancel} onAccept={onAccept} />
      </div>
    </ModalOverlay>
  );
}
