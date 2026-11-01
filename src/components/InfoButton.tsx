import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import { useDismissable } from "../hooks/useDismissable";

type InfoButtonProps = { title: string; label?: string; children: ReactNode };
type InfoSectionProps = { title: string; accent?: string; children: ReactNode };

// A small "ⓘ info" label that opens an explanatory modal. Chrome (overlay, header, scroll,
// close) lives here; callers pass a title and children. One centred card scrolls internally,
// no full-screen takeover.
export function InfoButton({title, label = "info", children}: InfoButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  useDismissable(open, () => setOpen(false));

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-orange-400 transition-colors">
        <Info size={13}/>{label}
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4 animate-overlay-fade" onClick={() => setOpen(false)}
          style={{ paddingTop: "calc(1rem + var(--safe-top))", paddingBottom: "calc(1rem + var(--safe-bottom))" }}>
          <div className="bg-slate-800 rounded-2xl w-full max-w-lg border border-slate-700 flex flex-col max-h-[85vh] overflow-hidden animate-scale-in" onClick={e => e.stopPropagation()}>
            <header className="flex items-center justify-between px-4 py-3 border-b border-slate-700 shrink-0">
              <span className="text-sm font-semibold">{title}</span>
              <button onClick={() => setOpen(false)} aria-label={t("common.close")} className="text-slate-400 hover:text-white text-lg leading-none px-1">x</button>
            </header>
            <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm text-slate-300 leading-relaxed">
              {children}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Reusable section block inside an info panel: a coloured heading + body.
export function InfoSection({title, accent = "text-orange-400", children}: InfoSectionProps) {
  return (
    <div className="bg-slate-900/50 rounded-2xl p-4 space-y-2">
      <p className={"text-sm font-semibold " + accent}>{title}</p>
      <div className="space-y-2 text-slate-400 text-xs leading-relaxed">{children}</div>
    </div>
  );
}
