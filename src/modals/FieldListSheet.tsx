import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Flag, Loader } from "lucide-react";
import { useDismissable } from "../hooks/useDismissable";
import { fmt } from "../utils/format";
import { aboutYourTime } from "../raceField";
import type { FieldName } from "../raceField";
import { reportRace } from "../races";
import { ConfirmButtons } from "../components/ModalPrimitives";

// Who's running (docs/race-field.md): the runners who chose to show their name, to a
// runner who joined. No ids reach the client, so a report carries only the name text.
type FieldListSheetProps = {
  editionId: string;
  count: number;
  named: FieldName[];
  goalSec: number | null;
  // Only a runner whose race is on their list can change how they appear.
  canChange: boolean;
  onChange: () => void;
  onClose: () => void;
  showToast?: (msg: string, type?: string) => void;
};

const initials = (name: string) => name.split(/\s+/).map(w => [...w][0] || "").join("").slice(0, 2).toUpperCase();

export function FieldListSheet({ editionId, count, named, goalSec, canChange, onChange, onClose, showToast }: FieldListSheetProps) {
  const { t } = useTranslation();
  useDismissable(true, onClose);
  const [reporting, setReporting] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  // A long list puts the confirm below the fold: bring it into view, focus included.
  useEffect(() => {
    if (!reporting) return;
    confirmRef.current?.scrollIntoView?.({ block: "nearest" });
    confirmRef.current?.focus();
  }, [reporting]);
  const me = named.find(n => n.me);
  const unnamed = Math.max(0, count - named.length);
  const near = aboutYourTime(named, goalSec);

  const report = async (name: string) => {
    setSending(true);
    try {
      await reportRace({ editionId, reason: "field_name", note: name });
      showToast?.(t("races.field.list.reported"));
      setReporting(null);
    } catch {
      showToast?.(t("races.field.toast.error"), "error");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-[2000] flex items-end animate-overlay-fade" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={t("races.field.list.title")}
        className="w-full max-h-full overflow-y-auto bg-slate-800 border-t border-slate-700 rounded-t-2xl p-4 space-y-3 animate-slide-up"
        style={{ paddingBottom: "calc(1.5rem + var(--safe-bottom))" }}
        onClick={e => e.stopPropagation()}>
        <div className="w-9 h-1 rounded-full bg-slate-600 mx-auto mb-1"/>
        <div>
          <h3 className="text-base font-bold text-white">{t("races.field.list.title")}</h3>
          <p className="text-sm text-slate-300 mt-1">{t("races.field.card.count", { count })}</p>
          {near > 0 && <p className="text-sm text-sky-300 mt-1">{t("races.field.list.near", { count: near })}</p>}
        </div>

        {named.length > 0 && (
          <ul className="space-y-1.5">
            {named.map((n, i) => (
              <li key={i} className="flex items-center gap-3 rounded-xl bg-slate-900/60 px-3 py-2">
                <span className="w-9 h-9 shrink-0 rounded-full bg-orange-700 text-orange-50 grid place-items-center text-xs font-extrabold">{initials(n.name)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-slate-100 truncate">
                    {n.name}{n.me && <span className="text-slate-400 font-normal"> {t("races.field.list.you")}</span>}
                  </span>
                  {n.goalSec != null && <span className="block text-xs text-slate-400">{t("races.field.list.goal", { time: fmt.dur(n.goalSec) })}</span>}
                </span>
                {!n.me && (
                  <button type="button" onClick={() => setReporting(n.name)} aria-label={t("races.field.list.report", { name: n.name })}
                    className="shrink-0 w-9 h-9 grid place-items-center rounded-lg text-slate-500 hover:text-slate-300">
                    <Flag size={15}/>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {unnamed > 0 && <p className="text-xs text-slate-400">{t("races.field.list.unnamed", { count: unnamed })}</p>}

        {reporting && (
          <div ref={confirmRef} tabIndex={-1} role="group" aria-label={t("races.field.list.reportSend")}
            className="rounded-xl border border-slate-600 p-3 space-y-2 outline-none">
            <p className="text-sm text-slate-200">{t("races.field.list.reportConfirm", { name: reporting })}</p>
            {sending
              ? <Loader size={16} className="animate-spin text-slate-400"/>
              : <ConfirmButtons onCancel={() => setReporting(null)} onAccept={() => void report(reporting)}
                  cancelLabel={t("races.field.list.reportCancel")} acceptLabel={t("races.field.list.reportSend")}/>}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-xs text-slate-400">
            {me ? t("races.field.list.appearAs", { name: me.name }) : t("races.field.list.appearCount")}
          </p>
          {canChange && (
            <button type="button" onClick={onChange} className="shrink-0 text-xs font-semibold text-orange-300 hover:text-orange-200">
              {t("races.field.card.change")}
            </button>
          )}
        </div>
        <p className="text-xs text-slate-500">{t("races.field.list.footer")}</p>
      </div>
    </div>
  );
}
