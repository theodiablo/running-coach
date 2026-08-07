import { useState, useRef, type ChangeEvent } from "react";
import { useTranslation, Trans } from "react-i18next";
import { Loader, Plus, Upload, MapPin, HeartPulse } from "lucide-react";
import { ymd } from "../utils/format";
import { RunFields } from "../components/RunFields";
import { runFormComplete, runFormToPatch, type RunFormValues } from "../utils/runForm";
import { MAX_GPX_BYTES } from "../utils/gpx";
import { fileProvider } from "../imports/providers/file";
import { isDuplicateRun } from "../imports/dedupe";
import { persistImportedRoutes } from "../imports/persistRoutes";
import { getSeenIds } from "../watch/import";
import type { ImportedRun } from "../imports/types";
import type { HrPending, Run } from "../types";

type LogPrefill = Partial<Run> & {
  pace?: number;
  wNum?: number;
  sId?: string;
  hrPending?: HrPending | null;
};

type LogViewProps = {
  addRuns: (runs: Partial<Run>[]) => void;
  onDone: () => void;
  onSaved?: () => void;
  prefill?: LogPrefill | null;
  openTracker?: () => void;
  // Existing log, used to dedupe file imports (comes in via the shared bag).
  runs?: Run[];
  // Land with the file-import panel already open (Settings -> Integrations
  // vendor guides jump here). Read once as initial state — RunningCoach
  // remounts LogView (key) on every goLog/goImport navigation.
  openImport?: boolean;
};

export function LogView({addRuns, onDone, onSaved, prefill, openTracker, runs, openImport}: LogViewProps) {
  const { t } = useTranslation();
  // A GPS-tracked run prefills its real measured duration; a plan session
  // prefills an estimate from km × prescribed pace.
  const estSec = prefill?.durationSec != null
    ? prefill.durationSec
    : (prefill?.km && prefill?.pace ? Math.round(prefill.km * prefill.pace) : 0);
  const INIT: RunFormValues = {
    date:   prefill?.date || ymd(new Date()),
    type:   prefill?.type || "EASY",
    km:     prefill?.km != null ? String(prefill.km) : "",
    dH:     estSec >= 3600 ? String(Math.floor(estSec / 3600)) : "",
    dM:     estSec >= 60   ? String(Math.floor((estSec % 3600) / 60)) : "",
    dS:     Math.round(estSec % 60) ? String(Math.round(estSec % 60)) : "",
    hr:    prefill?.hr    != null ? String(prefill.hr)    : "",
    hrMax: prefill?.hrMax != null ? String(prefill.hrMax) : "",
    elev: prefill?.elevation != null ? String(prefill.elevation) : "",effort:5,notes:"",
  };
  const [f,      setF]    = useState<RunFormValues>(INIT);
  const [busy,   setBusy] = useState(false);
  const [showImp,setImp]  = useState(!!openImport);
  const [csvMsg, setCsvMsg] = useState("");
  const [csvOk,  setCsvOk]  = useState(false);
  const fRef = useRef<HTMLInputElement | null>(null);
  const set  = (k: keyof RunFormValues, v: string | number) => setF(prev => ({...prev, [k]: v}));

  const showMsg = (msg: string, ok = false) => { setCsvOk(ok); setCsvMsg(msg); setTimeout(() => setCsvMsg(""), 3000); };

  const submit = async () => {
    if (!runFormComplete(f)) { showMsg(t("log.validation.required")); return; }
    setBusy(true);
    addRuns([{
      ...runFormToPatch(f),
      // Carry the GPS trace reference through from a live-tracked run.
      ...(prefill?.source   ? { source: prefill.source } : {}),
      ...(prefill?.routeId  ? { routeId: prefill.routeId } : {}),
      // Best efforts came from the trace, which this form can't edit — so they
      // survive the user correcting the distance or duration on the way in.
      ...(prefill?.bestEfforts ? { bestEfforts: prefill.bestEfforts } : {}),
      ...(prefill?.routeTmp ? { routeTmp: prefill.routeTmp, routePending: true } : {}),
      // HR-only sidecar (health-store import with HR but no GPS) — powers the
      // detail HR chart/zones; see the hrRouteId note in src/types.ts.
      ...(prefill?.hrRouteId ? { hrRouteId: prefill.hrRouteId } : {}),
      // Health-store HR wasn't ready at save — relink on next load (RunningCoach).
      // Two fields, one per platform: see the hrPendingHk note in src/types.ts.
      ...(prefill?.hrPending ? { hrPending: prefill.hrPending } : {}),
      ...(prefill?.hrPendingHk ? { hrPendingHk: prefill.hrPendingHk } : {}),
      // Carry the watch-import provenance through so repeated scans dedupe on it.
      ...(prefill?.hcId ? { hcId: prefill.hcId } : {}),
      ...(prefill?.startedAt ? { startedAt: prefill.startedAt } : {}),
    }]);
    setBusy(false); onSaved?.(); onDone();
  };

  // One handler for every supported activity file (CSV / GPX / TCX), routed
  // through the file import provider. Imports are deduped against the existing
  // log so re-importing an export can't double-log runs.
  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = "";
    if (file.size > MAX_GPX_BYTES) {
      showMsg(t("log.import.tooLarge"));
      return;
    }
    // FIT is a binary format — read it as bytes; text formats (CSV/GPX/TCX) as text.
    const isFit = /\.fit$/i.test(file.name);
    const reader = new FileReader();
    reader.onerror = () => showMsg(t("log.import.readError"));
    reader.onload = async ev => {
      const result = ev.target?.result;
      const bytes = isFit && result instanceof ArrayBuffer ? new Uint8Array(result) : undefined;
      const { runs: parsed, error } = fileProvider.parse!({
        name: file.name,
        text: isFit ? "" : String(result || ""),
        bytes,
      });
      if (!parsed.length) {
        showMsg(error || t("log.import.noRuns"));
        return;
      }
      const seen = getSeenIds();
      const fresh: ImportedRun[] = [];
      for (const r of parsed) {
        // fuzzy:false — a user-picked file must never silently drop a genuine
        // run (e.g. an AM/PM double of similar distance). Re-imports still
        // dedupe via ids and startedAt time overlap; anything else imports and
        // stays visible/deletable.
        if (!isDuplicateRun(r, (runs || []).concat(fresh as Run[]), seen, { fuzzy: false })) fresh.push(r);
      }
      if (!fresh.length) {
        showMsg(t("log.import.alreadyImported", { count: parsed.length }));
        return;
      }
      addRuns(await persistImportedRoutes(fresh));
      const skipped = parsed.length - fresh.length;
      showMsg(skipped
        ? t("log.import.importedSkipped", { count: fresh.length, skipped })
        : t("log.import.imported", { count: fresh.length }), true);
      setTimeout(() => onDone(), 1500);
    };
    if (isFit) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  };

  const impBtnCls = "flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border transition-colors " +
    (showImp ? "bg-orange-500 border-orange-500 text-white" : "border-orange-400/50 text-orange-400 hover:bg-orange-400/10");
  const msgCls = "mb-4 py-2.5 px-4 rounded-xl text-sm text-center " +
    (csvOk ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300");

  return (
    <div className="p-4 max-w-lg mx-auto">
      <div className="flex justify-between items-center mt-4 mb-5">
        <h2 className="text-xl font-bold">{t("log.title")}</h2>
        <button onClick={() => setImp(v => !v)} className={impBtnCls}>
          <Upload size={14}/>{t("log.importFileBtn")}
        </button>
      </div>

      {csvMsg && <div className={msgCls}>{csvMsg}</div>}

      {openTracker && !prefill?.source && (
        <>
          <button onClick={openTracker}
            className="w-full flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-600 text-white py-3 rounded-xl text-sm font-semibold transition-colors mb-4">
            <MapPin size={16}/>{t("log.trackLive")}
          </button>
          <div className="flex items-center gap-3 mb-5 text-xs uppercase tracking-widest text-slate-500">
            <div className="h-px flex-1 bg-slate-700"/>{t("log.orManual")}<div className="h-px flex-1 bg-slate-700"/>
          </div>
        </>
      )}

      {prefill?.source === "gps" && (
        <div className="bg-emerald-500/15 text-emerald-300 text-sm rounded-xl px-4 py-2.5 mb-5">
          {t("log.gpsBanner")}
        </div>
      )}

      {prefill?.source === "watch" && (
        <div className="bg-sky-500/15 text-sky-300 text-sm rounded-xl px-4 py-2.5 mb-5">
          {t("log.watchBanner")}
        </div>
      )}

      {showImp && (
        <div className="bg-slate-800 rounded-2xl p-4 mb-5 border border-slate-700 space-y-2.5">
          <p className="text-sm font-semibold text-slate-200">{t("log.import.title")}</p>
          <p className="text-xs text-slate-500">
            <Trans i18nKey="log.import.gpx"><span className="text-slate-300">FIT / GPX / TCX:</span> one activity with its route map, elevation and heart rate</Trans><br/>
            <Trans i18nKey="log.import.perActivity"><span className="text-slate-300">Get one run from Strava:</span> on strava.com open the activity, then ••• → Export Original (the .fit file) or Export GPX, and import the file here</Trans><br/>
            <Trans i18nKey="log.import.zepp"><span className="text-slate-300">Zepp CSV:</span> Profile → Privacy Center → Export Personal Data</Trans><br/>
            <Trans i18nKey="log.import.strava"><span className="text-slate-300">Strava CSV:</span> Settings → My Account → Download or Delete → Request Archive</Trans>
          </p>
          <input ref={fRef} type="file" accept={fileProvider.fileAccept} onChange={handleFile} className="hidden"/>
          <button onClick={() => fRef.current?.click()}
            className="w-full bg-orange-500 hover:bg-orange-600 text-white py-2.5 rounded-xl text-sm font-medium transition-colors">
            {t("log.import.chooseFile")}
          </button>
        </div>
      )}

      <div className="space-y-4">
        <RunFields form={f} onChange={set} phScope="log.fields" afterHr={
          (prefill?.hrPending || prefill?.hrPendingHk) && !f.hr ? (
            <p className="text-xs text-slate-400 flex items-start gap-1.5">
              <HeartPulse size={14} className="text-red-400 mt-0.5 shrink-0" />
              <span>{t("log.hrPendingNote", { store: prefill.hrPendingHk ? "Apple Health" : "Health Connect" })}</span>
            </p>
          ) : null
        }/>
        <button onClick={submit} disabled={busy}
          className="w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white py-3.5 rounded-xl font-semibold transition-colors flex items-center justify-center gap-2">
          {busy ? <Loader size={18} className="animate-spin"/> : <Plus size={18}/>}
          {t("log.saveRun")}
        </button>
      </div>
    </div>
  );
}
