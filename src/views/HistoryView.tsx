import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { History, Pencil, Trash2, Map as MapIcon } from "lucide-react";
import { currentLocaleTag } from "../i18n";
import { fmt } from "../utils/format";
import { RunRow } from "../components/RunRow";
import { RouteMap } from "../components/RouteMap";
import { useRouteTrace } from "../hooks/useRouteTrace";
import { EditRunModal } from "../modals/EditRunModal";
import type { ReactNode } from "react";
import { isCrossTraining } from "../types";
import type { Run, RunPatch, RunHighlight } from "../types";

type RouteMapLoaderProps = { run: Run };
type HistoryViewProps = {
  runs: Run[];
  deleteRun: (id: string) => void;
  updateRun: (id: string, patch: RunPatch) => void;
  goTab?: (tab: string) => void;
  // Open the full-screen per-run analytics view (map + charts + splits).
  openRunDetail?: (run: Run) => void;
  // Runs to scroll to and flag (async HR relink / watch import); cleared by the
  // hub on a timeout, so it's transient.
  highlight?: RunHighlight | null;
};
type RunGroup = { key: string; items: Run[] };

// Lazy-loads and renders a run's saved GPS trace (kept out of the runs blob). A
// synced run fetches from Supabase; one still pending upload reads the trace
// straight from the offline queue so it's viewable before it syncs.
function RouteMapLoader({run}: RouteMapLoaderProps) {
  const { t } = useTranslation();
  const { route } = useRouteTrace(run);
  if (route === undefined)
    return <div className="h-20 rounded-xl bg-slate-800 flex items-center justify-center text-slate-500 text-sm">{t("progress.history.loadingRoute")}</div>;
  if (!route)
    return <div className="h-20 rounded-xl bg-slate-800 flex items-center justify-center text-slate-500 text-sm">{t("progress.history.routeUnavailable")}</div>;
  return (
    <>
      {!run.routeId && (
        <p className="text-[11px] text-amber-400 text-center">{t("progress.history.pendingSync")}</p>
      )}
      <RouteMap points={route.points} interactive className="h-56 rounded-xl overflow-hidden" style={{}}/>
    </>
  );
}

// The full run log, newest first, grouped by month.
export function HistoryView({runs, deleteRun, updateRun, goTab, openRunDetail, highlight}: HistoryViewProps) {
  const { t } = useTranslation();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [editRun,   setEditRun]   = useState<Run | null>(null);
  const [mapId,     setMapId]     = useState<string | null>(null);

  // Scroll the first flagged run into view when we're navigated here from an HR /
  // import toast. Keyed on the id list so re-navigating to the same runs re-fires.
  const highlightKey = (highlight?.ids || []).join(",");
  useEffect(() => {
    if (!highlightKey) return;
    const el = document.getElementById("run-" + highlightKey.split(",")[0]);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightKey]);

  if (!runs.length) return (
    <div className="max-w-lg mx-auto flex flex-col items-center justify-center pt-24 text-center gap-3 p-4">
      <History size={48} className="text-slate-700"/>
      <p className="text-slate-400">{t("progress.history.empty")}</p>
      <button onClick={() => goTab && goTab("log")}
        className="bg-orange-500 hover:bg-orange-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors">
        {t("progress.history.recordFirst")}
      </button>
    </div>
  );

  // Runs arrive newest-first; bucket them into month sections in that order.
  // Running kilometres only — a cross-training session's distance is not one.
  const totKm  = runs.reduce((s, r) => s + (isCrossTraining(r) ? 0 : r.km || 0), 0);
  const groups: RunGroup[] = [];
  runs.forEach(r => {
    const key = new Date(r.date + "T12:00:00").toLocaleDateString(currentLocaleTag(), {month:"long", year:"numeric"});
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) { g = {key, items:[]}; groups.push(g); }
    g.items.push(r);
  });

  return (
    <div className="max-w-lg mx-auto p-4">
      <div className="mt-4 mb-4">
        <h2 className="text-xl font-bold">{t("progress.history.title")}</h2>
        <p className="text-slate-400 text-xs mt-0.5">
          {t("progress.history.subtitle", {count: runs.length, km: totKm.toFixed(0)})}
        </p>
      </div>

      <div className="space-y-5">
        {groups.map(g => (
          <div key={g.key}>
            <p className="text-slate-400 text-xs uppercase tracking-widest mb-2">{g.key}</p>
            <div className="space-y-2">
              {g.items.map(r => (
                <div key={r.id} id={"run-" + r.id} className="space-y-2 scroll-mt-20">
                  <RunRow run={r} dateFmt={fmt.date} showNotes
                    onClick={openRunDetail ? () => openRunDetail(r) : undefined}
                    highlight={!!(r.id && highlight?.ids.includes(r.id))}
                    badgeLabel={highlight?.label}
                    actions={
                    confirmId === r.id ? (
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button onClick={() => { if (r.id) deleteRun(r.id); setConfirmId(null); setMapId(m => m === r.id ? null : m); }}
                          className="text-xs font-semibold text-red-400 hover:text-red-300 px-2 py-2">{t("common.delete")}</button>
                        <button onClick={() => setConfirmId(null)}
                          className="text-xs text-slate-400 hover:text-slate-200 px-2 py-2">{t("common.cancel")}</button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-0.5 flex-shrink-0">
                        {(r.routeId || r.routeTmp) && (
                          <button onClick={() => setMapId(mapId === r.id ? null : r.id || null)} aria-label={t("progress.history.viewRoute")}
                            className={"flex items-center justify-center transition-colors " + (mapId === r.id ? "text-orange-400" : "text-slate-400 hover:text-orange-400")} style={{minWidth:40, minHeight:40}}>
                            <MapIcon size={16}/>
                          </button>
                        )}
                        <button onClick={() => setEditRun(r)} aria-label={t("progress.history.editRun")}
                          className="flex items-center justify-center text-slate-400 hover:text-orange-400 transition-colors" style={{minWidth:40, minHeight:40}}>
                          <Pencil size={16}/>
                        </button>
                        <button onClick={() => setConfirmId(r.id || null)} aria-label={t("progress.history.deleteRun")}
                          className="flex items-center justify-center text-slate-400 hover:text-red-400 transition-colors" style={{minWidth:40, minHeight:40}}>
                          <Trash2 size={16}/>
                        </button>
                      </div>
                    ) as ReactNode
                  }/>
                  {mapId === r.id && (r.routeId || r.routeTmp) && <RouteMapLoader run={r}/>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {editRun?.id && <EditRunModal run={editRun}
        onSave={(patch: RunPatch) => editRun.id && updateRun(editRun.id, patch)}
        onClose={() => setEditRun(null)}/>}
    </div>
  );
}
