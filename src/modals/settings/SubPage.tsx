import { useTranslation } from "react-i18next";
import { ChevronLeft } from "lucide-react";
import { useDismissable } from "../../hooks/useDismissable";

// Shared shell for a Settings sub-page. Rendered on top of the settings hub
// (z-[60] over its z-50), the same nesting the LiveRunTracker -> RouteFinderSheet
// pair uses. Registering the dismiss handler HERE (not in the parent) is what
// makes Android back / web Escape pop one level at a time: the hub registered
// first, this mounts second, and the stack is LIFO.
type SubPageProps = {
  title: string;
  onBack: () => void;
  children: React.ReactNode;
};

export function SubPage({ title, onBack, children }: SubPageProps) {
  const { t } = useTranslation();
  useDismissable(true, onBack);
  return (
    <div className="fixed inset-0 bg-slate-900 z-[60] flex flex-col animate-slide-up">
      <header className="flex items-center gap-2 px-4 border-b border-slate-800 shrink-0"
        style={{height:"calc(44px + var(--safe-top))", paddingTop:"var(--safe-top)"}}>
        <button onClick={onBack} aria-label={t("common.back")}
          className="text-slate-400 hover:text-white -ml-1 p-1">
          <ChevronLeft size={20}/>
        </button>
        <span className="text-sm font-semibold">{title}</span>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto p-4 space-y-5" style={{paddingBottom:"calc(1rem + var(--safe-bottom))"}}>
          {children}
        </div>
      </div>
    </div>
  );
}
