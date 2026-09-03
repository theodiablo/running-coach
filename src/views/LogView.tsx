import { useState, useRef, type ChangeEvent } from "react";
import { useTranslation, Trans } from "react-i18next";
import { Check, Loader, Plus, Upload, HeartPulse } from "lucide-react";
import { fmt, ymd } from "../utils/format";
import { track } from "../telemetry";
import { RunFields } from "../components/RunFields";
import { runFormComplete, runFormErrors, runFormHasDetail, runFormToPatch, secToDur, setRunField, type RunFormValues } from "../utils/runForm";
import { MAX_GPX_BYTES } from "../utils/gpx";
import { fileProvider } from "../imports/providers/file";
import { isDuplicateRun } from "../imports/dedupe";
import { persistImportedRoutes } from "../imports/persistRoutes";
import { carryPrefill } from "../utils/carryPrefill";
import { runFitsSession } from "../utils/sessionMatch";
import { getSeenIds } from "../watch/import";
import type { ImportedRun } from "../imports/types";
import { isCrossTraining } from "../types";
import type { HrPending, Run } from "../types";
import type { SessionWithWeek } from "../utils/overdue";

type LogPrefill = Partial<Run> & {
  pace?: number;
  // The plan session this save settles, as a whole row — enough to re-check the
  // pairing against what the runner types, which a bare {wNum, sId} was not.
  session?: SessionWithWeek | null;
  // Whether the app matched that session to the run (src/utils/sessionMatch.ts)
  // rather than the runner picking it. An offer is shown for confirmation and
  // can be declined here; a chosen session has already been decided.
  sessionOffered?: boolean;
  hrPending?: HrPending | null;
};

// The manual run form, and — as its own screen, never alongside it — the file
// importer. Choosing *how* to record is the RecordSheet's job (the center FAB);
// this view is only ever reached with that choice already made, so it never
// offers a recorder. Four arrivals, one title each: entering a run by hand,
// logging a plan session, reviewing something a recorder just captured
// (`prefill.source`), and importing a file.
type LogViewProps = {
  addRuns: (runs: Partial<Run>[]) => Run[];
  onDone: () => void;
  // The saved runs (with their minted ids) and the plan session the save
  // settles, if any — the hub ticks it off and records which run did it.
  onSaved?: (saved: Run[], link: { wNum: number; sId: string } | null) => void;
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
    dur:    secToDur(estSec),
    hr:    prefill?.hr    != null ? String(prefill.hr)    : "",
    hrMax: prefill?.hrMax != null ? String(prefill.hrMax) : "",
    elev: prefill?.elevation != null ? String(prefill.elevation) : "",effort:0,
    // A cloud import arrives with its provenance note ("Imported from Suunto").
    // Show it rather than dropping it: the batch path saves it verbatim, so a
    // blank field here made the same run look different depending on whether it
    // arrived alone or with others.
    notes: prefill?.notes || "",
  };
  const [f,      setF]    = useState<RunFormValues>(INIT);
  const [busy,   setBusy] = useState(false);
  // Required-field errors show only once a save has been attempted — an empty
  // form isn't a mistake yet.
  const [attempted, setAttempted] = useState(false);
  // An offered session is confirmed by default — it is shown, named and dated
  // right above the Save button, so it is a decision the runner sees rather
  // than a plan edit that happens behind a disappearing toast. Declining
  // saves the run on its own.
  const [declined, setDeclined] = useState(false);
  const [importing, setImporting] = useState(!!openImport);
  const [csvMsg, setCsvMsg] = useState("");
  const [csvOk,  setCsvOk]  = useState(false);
  const fRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLDivElement | null>(null);
  const set  = (k: keyof RunFormValues, v: string | number) => setF(prev => setRunField(prev, k, v));

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
    const saved = addRuns([{
      // Everything the recorder or importer measured that this form can't edit
      // rides through untouched; the form's own values win. An allowlist here
      // silently dropped extId, and every cloud sync then reported "no new
      // runs" — carryPrefill ends that class of bug.
      ...carryPrefill(prefill),
      ...runFormToPatch(f),
    }]);
    setBusy(false); onSaved?.(saved || [], link); onDone();
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
  // Two ways to get here — the runner picked the session (wNum/sId), or the app
  // matched one to the run and is offering it.
  const linked = prefill?.session && !(prefill.sessionOffered && declined) ? prefill.session : null;
  // Re-checked against the FORM, not the prefill: the runner can still change
  // the date and the type, and a prefilled link that no longer fits must let go
  // rather than tick off a tempo with a bike ride. Read at render, so the
  // banner disappears the moment the edit invalidates it instead of the save
  // quietly doing something the screen still promises.
  const fits = !!linked && runFitsSession(linked, {date: f.date, type: f.type});
  const session = linked && fits ? linked : null;
  const offered = session && prefill?.sessionOffered ? session : null;
  const link = session ? { wNum: session.wNum, sId: session.id } : null;
  // A cross-training session's prescription is its DURATION: buildPlan gives it
  // a synthetic km purely to satisfy the coach validator, and showing that as a
  // target would claim a distance nobody covered (docs/indoor-sessions.md).
  const sessionMins = session?.sd?.minutes || 0;
  const runKm = session && !isCrossTraining(session) ? Number(session.km) || 0 : 0;
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

      {/* Which session you're logging, and what saving will do to it. A chosen
          session is skipped when a source banner already explains the arrival
          (a tracked run that happens to be linked says it on the Save button
          instead); an OFFER always shows — it is the thing being confirmed. */}
      {session && (offered || !prefill?.source) && (
        <div className="bg-orange-500/10 border border-orange-500/25 rounded-xl px-4 py-3 mb-5 space-y-0.5">
          <p className="text-sm font-semibold text-white">
            {offered
              ? t("log.session.offerHeading", { date: fmt.sht(session.date) })
              : t("log.session.heading", { week: session.wNum, date: fmt.sht(session.date) })}
          </p>
          {/* A cross-training session's prescription is its duration, which
              planSessionPrefill only carries when the session declares one —
              claiming "0min" would be worse than saying nothing. */}
          {(runKm || sessionMins) && (
            <p className="text-sm text-orange-200">
              {runKm
                ? t("log.session.targetRun", {
                    km: session.km,
                    type: t("common.types." + session.type, { defaultValue: session.type }),
                    pace: fmt.pace(session.pace),
                  })
                : t("log.session.targetOther", { mins: fmt.mins(sessionMins) })}
            </p>
          )}
          <p className="text-xs text-slate-400">{t("log.session.ticksOff")}</p>
          {/* The one control that makes this an offer rather than a silent
              plan edit: the run saves on its own and the session stays open. */}
          {offered && (
            <button onClick={() => setDeclined(true)}
              className="pt-1 text-xs font-semibold text-slate-400 hover:text-slate-200 underline underline-offset-2 transition-colors">
              {t("log.session.decline")}
            </button>
          )}
        </div>
      )}

      {/* Declining is undoable until the run is saved — nothing has happened yet. */}
      {declined && prefill?.sessionOffered && prefill.session && (
        <button onClick={() => setDeclined(false)}
          className="w-full text-xs text-slate-500 hover:text-slate-300 underline underline-offset-2 mb-5 transition-colors">
          {t("log.session.declineUndo", { date: fmt.sht(prefill.session.date) })}
        </button>
      )}

      {/* Edited out of its own session's reach. Saying so beats a banner that
          silently vanishes, having promised a tick that is no longer coming. */}
      {linked && !fits && (
        <p className="text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/25 rounded-xl px-4 py-2.5 mb-5">
          {t("log.session.noLongerFits", { date: fmt.sht(linked.date) })}
        </p>
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
