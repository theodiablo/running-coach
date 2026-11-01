// Shared pieces for the full-screen overlay sheets (prominent disclosures, confirm-style
// nudges): backdrop/positioning and the accept/cancel button pair, so styling and
// z-index fixes land in one place.
import type { ReactNode } from "react";

type ModalOverlayProps = { children: ReactNode };
type ConfirmButtonsProps = {
  onCancel: () => void;
  onAccept: () => void;
  cancelLabel: string;
  acceptLabel: string;
};

// Full-screen dim backdrop, centered content, consistent stacking above the
// live tracker (z-50) and other in-app sheets.
export function ModalOverlay({ children }: ModalOverlayProps) {
  return (
    <div className="fixed inset-0 bg-black/70 z-[2000] flex items-center justify-center p-4 animate-overlay-fade"
      style={{ paddingTop: "calc(1rem + var(--safe-top))", paddingBottom: "calc(1rem + var(--safe-bottom))" }}>
      <div className="w-full flex justify-center animate-scale-in">{children}</div>
    </div>
  );
}

// The cancel/accept button pair shared by every disclosure and confirm sheet.
export function ConfirmButtons({ onCancel, onAccept, cancelLabel, acceptLabel }: ConfirmButtonsProps) {
  return (
    <div className="grid grid-cols-2 gap-2 pt-1">
      <button onClick={onCancel}
        className="py-2.5 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200">
        {cancelLabel}
      </button>
      <button onClick={onAccept}
        className="py-2.5 rounded-xl text-sm font-semibold bg-orange-500 hover:bg-orange-600 text-white">
        {acceptLabel}
      </button>
    </div>
  );
}
