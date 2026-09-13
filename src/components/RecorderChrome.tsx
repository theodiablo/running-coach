import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useDismissable } from "../hooks/useDismissable";
import { ModalOverlay, ConfirmButtons } from "./ModalPrimitives";

// The parts both recorders (LiveRunTracker, IndoorTracker) render identically.
// They stay separate screens on purpose — see IndoorTracker's header comment —
// but these three are the same control, and a change to one has to reach both.

const CTRL_CLS = "flex-1 flex items-center justify-center gap-2 py-4 rounded-2xl text-base font-semibold transition-[background-color,transform] active:scale-95 disabled:opacity-50 disabled:active:scale-100 ";

// Large, glove-friendly control button.
export function Ctrl({ onClick, color, children, disabled = false }: {
  onClick: () => void; color: string; children: ReactNode; disabled?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} className={CTRL_CLS + color}>
      {children}
    </button>
  );
}

export const HOLD_MS = 1500;

// Ctrl that only fires after a sustained press, for the one control a slipped
// thumb mid-run can't take back (Finish tears the recording down: watches, wake
// lock, foreground service, live share). A short tap swaps the label for the
// hint instead of failing silently, which is what makes the gesture teachable.
// The press is tracked with pointer capture, so a finger sliding inside the
// button keeps counting; anything that ends the press early cancels it.
export function HoldCtrl({ onHold, color, children, hint, holdMs = HOLD_MS }: {
  onHold: () => void; color: string; children: ReactNode; hint: string; holdMs?: number;
}) {
  const [holding, setHolding] = useState(false);
  const [hinting, setHinting] = useState(false);
  const fire = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintOff = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (fire.current) clearTimeout(fire.current);
    if (hintOff.current) clearTimeout(hintOff.current);
  }, []);

  const start = () => {
    if (fire.current) return;
    setHolding(true);
    setHinting(false);
    fire.current = setTimeout(() => {
      fire.current = null;
      setHolding(false);
      onHold();
    }, holdMs);
  };
  // Released early: nothing happens to the run, and the button says why.
  const cancel = () => {
    if (!fire.current) return;
    clearTimeout(fire.current);
    fire.current = null;
    setHolding(false);
    setHinting(true);
    if (hintOff.current) clearTimeout(hintOff.current);
    hintOff.current = setTimeout(() => setHinting(false), 2000);
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    start();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.repeat || (e.key !== " " && e.key !== "Enter")) return;
    e.preventDefault(); // Enter/Space would otherwise also click the button
    start();
  };
  const onKeyUp = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === " " || e.key === "Enter") cancel();
  };

  return (
    <button
      onPointerDown={onPointerDown} onPointerUp={cancel} onPointerCancel={cancel}
      onKeyDown={onKeyDown} onKeyUp={onKeyUp} onBlur={cancel}
      className={CTRL_CLS + color + " relative overflow-hidden"}>
      {/* Informative progress, not decoration — so it's exempt from the global
          reduced-motion block (src/index.css), like the spinner. */}
      <span aria-hidden="true"
        className={"hold-fill absolute inset-y-0 left-0 bg-black/25 " + (holding ? "w-full" : "w-0")}
        style={{ transitionProperty: "width", transitionTimingFunction: "linear", transitionDuration: holding ? `${holdMs}ms` : "0ms" }} />
      <span className="relative flex items-center justify-center gap-2">
        {hinting ? hint : <>{children}<span className="sr-only">{hint}</span></>}
      </span>
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
