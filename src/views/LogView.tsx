import { useState, useRef, type ChangeEvent } from "react";
import { useTranslation, Trans } from "react-i18next";
import { Check, Loader, Plus, Upload, HeartPulse } from "lucide-react";
import { fmt, ymd } from "../utils/format";
import { track } from "../telemetry";
import { RunFields } from "../components/RunFields";
import { runFormComplete, runFormErrors, runFormHasDetail, runFormToPatch, type RunFormValues } from "../utils/runForm";
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

// The manual run form, and — as its own screen, never alongside it — the file
// importer. Choosing *how* to record is the RecordSheet's job (the center FAB);
// this view is only ever reached with that choice already made, so it never
// offers a recorder. Four arrivals, one title each: entering a run by hand,
// logging a plan session, reviewing something a recorder just captured
// (`prefill.source`), and importing a file.
type LogViewProps = {
  addRuns: (runs: Partial<Run>[]) => void;
  onDone: () => void;
  onSaved?: () => void;
  prefill?: LogPrefill | null;
  // Existing log, used to dedupe file imports (comes in via the shared bag).
  runs?: Run[];
  // Land on the file importer instead of the form (Settings -> Integrations).
  // Read once as initial state — RunningCoach remounts LogView (key) on every
  // goLog/goImport navigation.
  openImport?: boolean;
};

export function LogView({addRuns, onDone, onSaved, prefill, runs, openImport}: LogViewProps) {
  const { t } = useTranslation();
  // A GPS-tracked run prefills its real measured duration; a plan session
  // prefills an estimate from km × prescribed pace.
  const estSec = prefill?.durationSec != null
    ? prefill.durationSec
    : (prefill?.km && prefill?.pace ? Math.round(prefill.km * prefill.pace) : 0);
  const INIT: RunFormValues = {
    date:   prefill?.date || ymd(new Date()),
    type:   prefill?.type || "EASY",
    activity: prefill?.activity || "",
    // An indoor session has no distance to prefill; a literal 0 in the field
    // would read as a measurement rather than "not applicable".
    km:     prefill?.source === "indoor" ? "" : prefill?.km != null ? String(prefill.km) : "",
    dH:     estSec >= 3600 ? String(Math.floor(estSec / 3600)) : "",
    dM:     estSec >= 60   ? String(Math.floor((estSec % 3600) / 60)) : "",
    dS:     Math.round(estSec % 60) ? String(Math.round(estSec % 60)) : "",
    hr:    prefill?.hr    != null ? String(prefill.hr)    : "",
    hrMax: prefill?.hrMax != null ? String(prefill.hrMax) : "",
    elev: prefill?.elevation != null ? String(prefill.elevation) : "",effort:0,notes:"",
  };
  const [f,      setF]    = useState<RunFormValues>(INIT);
  const [busy,   setBusy] = useState(false);
  // Required-field errors show only once a save has been attempted — an empty
  // form isn't a mistake yet.
  const [attempted, setAttempted] = useState(false);
  const [importing, setImporting] = useState(!!openImport);
  const [csvMsg, setCsvMsg] = useState("");
  const [csvOk,  setCsvOk]  = useState(false);
  const fRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLDivElement | null>(null);
  const set  = (k: keyof RunFormValues, v: string | number) => setF(prev => ({...prev, [k]: v}));

  const showMsg = (msg: string, ok = false) => { setCsvOk(ok); setCsvMsg(msg); setTimeout(() => setCsvMsg(""), 3000); };

  const submit = async () => {
    if (!runFormComplete(f)) {
      // Say it on the field, and take the runner to it: the old banner rendered
      // under the page title, several hundred pixels above the button they had
      // just pressed, then deleted itself after three seconds.
      setAttempted(true);
      const bad = runFormErrors(f).km ? "km" : "duration";
      formRef.current?.querySelector<HTMLElement>(`[data-field="${bad}"]`)
        ?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      return;
    }
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
      // How often file import is actually used decides whether it stays a
      // Settings-only chore. Count only; no file names or run data.
      track("run_imported", { count: fresh.length });
      const skipped = parsed.length - fresh.length;
      showMsg(skipped
        ? t("log.import.importedSkipped", { count: fresh.length, skipped })
        : t("log.import.imported", { count: fresh.length }), true);
      setTimeout(() => onDone(), 1500);
    };
    if (isFit) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  };

  const msgCls = "mb-4 py-2.5 px-4 rounded-xl text-sm text-center " +
    (csvOk ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300");

  // Logging a plan session: saving it also ticks the session off (RunningCoach's
  // onSaved), so the screen says so rather than letting it happen silently.
  const session = prefill?.wNum != null && prefill?.sId ? prefill : null;
  const title = importing
    ? t("log.titleImport")
    : prefill?.source ? t("log.titleReview")
    : session ? t("log.titleSession")
    : t("log.titleManual");

  if (importing) return (
    <div className="p-4 max-w-lg mx-auto">
      <h2 className="text-xl font-bold mt-4 mb-5">{title}</h2>
      {csvMsg && <div className={msgCls}>{csvMsg}</div>}
      <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700 space-y-2.5">
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
        <p className="text-xs text-slate-500">{t("log.import.dedupeNote")}</p>
      </div>
      <button onClick={() => setImporting(false)}
        className="w-full mt-4 py-2.5 text-sm font-semibold text-slate-400 hover:text-slate-200 transition-colors">
        {t("log.import.enterInstead")}
      </button>
    </div>
  );

  return (
    <div className="p-4 max-w-lg mx-auto">
      <h2 className="text-xl font-bold mt-4 mb-5">{title}</h2>

      {csvMsg && <div className={msgCls}>{csvMsg}</div>}

      {prefill?.source === "gps" && (
        <div className="bg-emerald-500/15 text-emerald-300 text-sm rounded-xl px-4 py-2.5 mb-5">
          {t("log.gpsBanner")}
        </div>
      )}

      {prefill?.source === "indoor" && (
        <div className="bg-violet-500/15 text-violet-200 text-sm rounded-xl px-4 py-2.5 mb-5">
          {t("log.indoorBanner")}
        </div>
      )}

      {prefill?.source === "watch" && (
        <div className="bg-sky-500/15 text-sky-300 text-sm rounded-xl px-4 py-2.5 mb-5">
          {t("log.watchBanner")}
        </div>
      )}

      {/* Which session you're logging, and what saving will do to it. Skipped
          when a source banner already explains the arrival (a tracked run that
          happens to be linked says it on the Save button instead). */}
      {session && !prefill?.source && (
        <div className="bg-orange-500/10 border border-orange-500/25 rounded-xl px-4 py-3 mb-5 space-y-0.5">
          <p className="text-sm font-semibold text-white">
            {t("log.session.heading", { week: session.wNum, date: fmt.sht(session.date || "") })}
          </p>
          <p className="text-sm text-orange-200">
            {session.km
              ? t("log.session.targetRun", {
                  km: session.km,
                  type: t("common.types." + session.type, { defaultValue: session.type }),
                  pace: fmt.pace(session.pace),
                })
              : t("log.session.targetOther", { mins: fmt.mins(Math.round((session.durationSec || 0) / 60)) })}
          </p>
          <p className="text-xs text-slate-400">{t("log.session.ticksOff")}</p>
        </div>
      )}

      <div className="space-y-4" ref={formRef}>
        <RunFields form={f} onChange={set} phScope="log.fields"
          errors={attempted ? runFormErrors(f) : null}
          // A recorder or import already filled some of the detail — never hide
          // what the runner arrived with.
          detailsOpen={runFormHasDetail(INIT) || !!prefill?.hrPending || !!prefill?.hrPendingHk}
          afterHr={
          (prefill?.hrPending || prefill?.hrPendingHk) && !f.hr ? (
            <p className="text-xs text-slate-400 flex items-start gap-1.5">
              <HeartPulse size={14} className="text-red-400 mt-0.5 shrink-0" />
              <span>{t("log.hrPendingNote", { store: prefill.hrPendingHk ? "Apple Health" : "Health Connect" })}</span>
            </p>
          ) : null
        }/>
        <button onClick={submit} disabled={busy}
          className="w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white py-3.5 rounded-xl font-semibold transition-colors flex items-center justify-center gap-2">
          {busy ? <Loader size={18} className="animate-spin"/> : session ? <Check size={18}/> : <Plus size={18}/>}
          {session ? t("log.saveAndTick") : t("log.saveRun")}
        </button>
        {attempted && !runFormComplete(f) && (
          <p className="text-xs text-red-300 text-center -mt-2">{t("log.validation.fixAbove")}</p>
        )}
        {/* The one place outside Settings that mentions file import: you have
            just said a run happened and didn't arrive on its own. */}
        {!prefill && (
          <button onClick={() => setImporting(true)}
            className="w-full flex items-center justify-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors">
            <Upload size={13}/>{t("log.haveAFile")}
          </button>
        )}
      </div>
    </div>
  );
}
