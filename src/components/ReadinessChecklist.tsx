import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader } from "lucide-react";
import { checkReadiness, fixReadiness, READINESS_ORDER, type Readiness, type ReadinessId } from "../geo/readiness";
import { isBgLocationDisclosed } from "../geo/disclosure";
import { BgLocationDisclosure } from "../modals/BgLocationDisclosure";

// What a long screen-off recording needs, sorted before race day instead of at
// the start line. Never blocks: every row is a fix offered, not a gate.
export function ReadinessChecklist() {
  const { t } = useTranslation();
  const [state, setState] = useState<Readiness | null>(null);
  const [busy, setBusy] = useState<ReadinessId | null>(null);
  const [disclose, setDisclose] = useState(false);

  const recheck = useCallback(() => {
    void checkReadiness().then(setState).catch(() => setState({}));
  }, []);
  // Battery and "Allow all the time" are Settings round trips, so re-read on return.
  useEffect(() => {
    recheck();
    const onVisible = () => { if (document.visibilityState === "visible") recheck(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [recheck]);

  const fix = async (id: ReadinessId) => {
    setBusy(id);
    await fixReadiness(id);
    setBusy(null);
    recheck();
  };
  // Play requires the disclosure before any location prompt.
  const onFix = (id: ReadinessId) => {
    if (id === "location" && !isBgLocationDisclosed()) { setDisclose(true); return; }
    void fix(id);
  };

  if (!state) {
    return <div className="flex justify-center py-6"><Loader size={18} className="animate-spin text-slate-400"/></div>;
  }
  const rows = READINESS_ORDER.filter(id => state[id] !== undefined);

  return (
    <div className="bg-slate-800 rounded-2xl divide-y divide-slate-700/60">
      {rows.map(id => {
        const ok = !!state[id];
        // "Allow all the time" is only offered once ordinary location is granted.
        const blocked = id === "background" && !state.location;
        return (
          <div key={id} className="flex items-center gap-3 p-3">
            {ok ? (
              <span className="w-6 h-6 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0">
                <Check size={14} className="text-emerald-300"/>
              </span>
            ) : (
              <span className="w-6 h-6 rounded-full border-2 border-dashed border-amber-400/70 shrink-0" aria-hidden/>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-slate-200">{t(`onboarding.liveReady.${id}.title`)}</p>
              <p className="text-xs text-slate-400">{t(`onboarding.liveReady.${id}.sub`)}</p>
            </div>
            {!ok && (
              <button type="button" onClick={() => onFix(id)} disabled={blocked || busy !== null}
                className="shrink-0 text-xs font-semibold text-orange-200 bg-orange-500/15 hover:bg-orange-500/25 rounded-lg px-3 py-1.5 disabled:opacity-40 transition-colors">
                {busy === id ? <Loader size={13} className="animate-spin"/> : t(`onboarding.liveReady.${id}.action`)}
              </button>
            )}
          </div>
        );
      })}
      {disclose && (
        <BgLocationDisclosure
          onAccept={() => { setDisclose(false); void fix("location"); }}
          onCancel={() => setDisclose(false)}/>
      )}
    </div>
  );
}
