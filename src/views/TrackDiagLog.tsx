import { useEffect, useState } from "react";
import { RefreshCw, Trash2, Copy, EyeOff, Upload } from "lucide-react";
import { getTrackLog, clearTrackLog, type GeoDiagEvent } from "../geo/trackLog";
import { clearShellLog, fileShellReport, readShellLog, type FileReportResult, type ShellDiagReport } from "../diag/shellLog";

// Hidden developer diagnostics for a run's sensor streams — GPS and the live
// heart-rate link (revealed together with the watch sync log from Settings →
// Connections by tapping the section title 5×). Shows the raw event stream for
// recent runs so a screen-off track hole or an HR dropout can be diagnosed: the
// GPS summary answers "did fixes keep arriving while the app was backgrounded"
// (the whole question behind the gaps), and the HR summary answers the one that
// cannot be told apart from the screen — whether the strap stopped beating, or
// this app stopped being fed beats it was still sending. Raw and English-only —
// a debug surface, not a user feature, so not wired through i18n.

const KIND_CLS: Record<string, string> = {
  "native-fix": "bg-sky-500/15 text-sky-300 border-sky-500/30",
  fix: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  drop: "bg-slate-600/30 text-slate-400 border-slate-500/40",
  gap: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  hidden: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  visible: "bg-emerald-600/15 text-emerald-300 border-emerald-600/30",
  perm: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  error: "bg-rose-600/20 text-rose-300 border-rose-600/40",
  start: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  stop: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  "watch-start": "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  "watch-stop": "bg-slate-600/30 text-slate-400 border-slate-500/40",
  "hr-beat": "bg-pink-500/15 text-pink-300 border-pink-500/30",
  "hr-status": "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30",
  "hr-connect": "bg-fuchsia-600/20 text-fuchsia-300 border-fuchsia-600/40",
  "hr-stall": "bg-rose-500/15 text-rose-300 border-rose-500/30",
  "hr-scan": "bg-violet-500/15 text-violet-300 border-violet-500/30",
  "hr-journal": "bg-slate-600/30 text-slate-400 border-slate-500/40",
  "hr-save": "bg-pink-600/20 text-pink-200 border-pink-600/40",
  power: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
};

const clock = (ms: number) => {
  try {
    const d = new Date(ms);
    return d.toLocaleTimeString([], { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
  } catch { return String(ms); }
};
const secs = (ms?: number) => (ms == null ? "" : `+${(ms / 1000).toFixed(1)}s`);

// Walk the stream tracking visibility, and measure the largest silence between
// consecutive raw fixes while hidden vs visible — the direct read on whether the
// foreground service keeps feeding fixes with the screen off.
function summarize(events: GeoDiagEvent[]) {
  let visible = true, lastFixT = 0;
  let maxHidden = 0, maxVisible = 0, hiddenFixes = 0, visibleFixes = 0;
  for (const e of events) {
    if (e.kind === "start" || e.kind === "resume") { visible = true; lastFixT = 0; }
    else if (e.kind === "visible") visible = true;
    else if (e.kind === "hidden") visible = false;
    else if (e.kind === "native-fix") {
      const tt = e.t ?? e.at;
      if (lastFixT) {
        const gap = tt - lastFixT;
        if (visible) { if (gap > maxVisible) maxVisible = gap; visibleFixes++; }
        else { if (gap > maxHidden) maxHidden = gap; hiddenFixes++; }
      } else if (visible) visibleFixes++; else hiddenFixes++;
      lastFixT = tt;
    }
  }
  return { maxHidden, maxVisible, hiddenFixes, visibleFixes };
}

// The heart-rate half, which is a different question from the GPS one: not "how
// big was the hole" but "which layer made it". A delivery stall (the GATT
// callback still seeing beats while this JS stops being fed) and a dead link
// look identical on screen and are fixed in completely different places, so the
// counts are reported apart rather than added up into "HR dropouts".
function summarizeHr(events: GeoDiagEvent[]) {
  let beats = 0, deliveryStalls = 0, deadLink = 0, peerDrops = 0, connectFails = 0, scansThrottled = 0;
  let save = "", power = "";
  for (const e of events) {
    if (e.kind === "hr-beat") beats += e.n ?? 1;
    else if (e.kind === "hr-stall") {
      if (e.msg === "delivery-stall") deliveryStalls++;
      else if (e.msg !== "late-fire") deadLink++;
    }
    else if (e.kind === "hr-connect" && e.ok === false) {
      if (e.msg === "disconnected by peer") peerDrops++;
      else if (e.msg?.startsWith("attempt")) connectFails++;
    }
    else if (e.kind === "hr-scan" && e.msg === "throttled") scansThrottled++;
    else if (e.kind === "hr-save") save = e.msg || "";
    else if (e.kind === "power") power = e.msg || "";
  }
  return { beats, deliveryStalls, deadLink, peerDrops, connectFails, scansThrottled, save, power };
}

function EventRow({ e }: { e: GeoDiagEvent }) {
  const big = (e.kind === "native-fix" || e.kind === "fix" || e.kind === "gap") && (e.sinceMs ?? 0) > 60000;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1 border-t border-slate-700/40 text-[11px]">
      <span className="text-slate-500 tabular-nums">{clock(e.t ?? e.at)}</span>
      <span className={`px-1.5 py-0.5 rounded border font-semibold ${KIND_CLS[e.kind] || KIND_CLS.drop}`}>{e.kind}</span>
      {e.msg && <span className="text-slate-300">{e.msg}</span>}
      {e.acc != null && <span className="text-slate-500">±{Math.round(e.acc)}m</span>}
      {e.sinceMs != null && <span className={big ? "text-rose-400 font-semibold" : "text-slate-500"}>{secs(e.sinceMs)}</span>}
      {e.bpm != null && <span className="text-pink-300 font-semibold">{e.bpm}bpm</span>}
      {e.n != null && <span className="text-slate-500">×{e.n}</span>}
      {e.kind === "perm" && <span className={e.ok ? "text-emerald-400" : "text-rose-400"}>{e.ok ? "granted" : "denied"}</span>}
    </div>
  );
}

// Each failure sends the reader somewhere different, so none of them may be
// reported as one vague "couldn't send": `not-armed` in particular is fixed by
// re-arming the developer log, not by finding a connection.
const SEND_RESULT: Record<FileReportResult, string> = {
  sent: "Report sent.",
  "not-armed": "Not sent — the developer log is off. Re-arm it (tap the section title 5×) and try again.",
  "signed-out": "Not sent — signed out.",
  empty: "Nothing to send — no shell events and no sensor log yet.",
  failed: "Couldn't send — offline, or the insert was rejected.",
};

// The shell half: what happened to the app itself while it was backgrounded.
// Always populated (the native log is not behind the debug flag), and shown
// first because it is the question the fix stream below can't answer — when the
// renderer dies, the JS log just stops, identically to a frozen one.
function ShellSection({ report, onRefresh }: { report: ShellDiagReport; onRefresh: () => void }) {
  const wipe = () => { clearShellLog(); onRefresh(); };
  const copy = () => {
    try { navigator.clipboard?.writeText(JSON.stringify(report, null, 2)); } catch { /* ignore */ }
  };
  // Filing is deliberate: this panel is only open because something went wrong,
  // and the native log survives whatever it was, so there is nothing to catch
  // in the moment. (It used to file itself on boot, on every foreground and on
  // a 60s timer, which cost an IPC round-trip per foreground on every Android
  // install and, off Android, inserted a row a minute forever.)
  const [sent, setSent] = useState<"" | FileReportResult>("");
  const send = () => {
    void fileShellReport("manual: sent from developer log")
      .then(setSent).catch(() => setSent("failed"));
  };
  const rows = [...report.events].reverse(); // newest first
  return (
    <div className="space-y-2 pt-3 mt-1 border-t border-slate-700/60">
      <div className="flex items-center gap-2">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide flex-1">Shell / renderer log (dev)</p>
        <button type="button" aria-label="Refresh shell log" onClick={onRefresh} className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300"><RefreshCw size={13} /></button>
        <button type="button" aria-label="Copy shell log as JSON" onClick={copy} className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300"><Copy size={13} /></button>
        <button type="button" aria-label="Send shell log to the maintainer" onClick={send} className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300"><Upload size={13} /></button>
        <button type="button" aria-label="Clear shell log" onClick={wipe} className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300"><Trash2 size={13} /></button>
      </div>
      {sent && <p className={`text-[11px] ${sent === "sent" ? "text-emerald-400" : "text-rose-400"}`}>
        {SEND_RESULT[sent]}
      </p>}
      <p className="text-[11px] text-slate-500 -mt-1">
        Recorded natively, so it survives the WebView dying — which is exactly when the GPS log below
        stops. Always on: no need to have armed anything before the run that went wrong.
      </p>
      {report.verdict && (
        <p className="text-[11px] leading-snug rounded-lg bg-slate-900/60 border border-slate-700 px-2.5 py-2 text-slate-200">
          {report.verdict}
        </p>
      )}
      {report.device && <p className="text-[11px] text-slate-500">{report.device}</p>}
      {rows.length === 0
        ? <p className="text-xs text-slate-500 py-2">Nothing recorded yet.</p>
        : (
          <div className="max-h-64 overflow-y-auto">
            {rows.map((e, i) => (
              <div key={`${e.at}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1 border-t border-slate-700/40 text-[11px]">
                <span className="text-slate-500 tabular-nums">{clock(e.at)}</span>
                <span className={"px-1.5 py-0.5 rounded border font-semibold " + (SHELL_KIND_CLS[e.kind] || KIND_CLS.drop)}>{e.kind}</span>
                {e.detail && <span className="text-slate-300 break-all">{e.detail}</span>}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

const SHELL_KIND_CLS: Record<string, string> = {
  "renderer-gone": "bg-rose-600/20 text-rose-300 border-rose-600/40",
  "renderer-loop-guard": "bg-rose-600/20 text-rose-300 border-rose-600/40",
  "rebuild-deferred": "bg-amber-500/15 text-amber-300 border-amber-500/30",
  rebuild: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  create: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  background: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  foreground: "bg-emerald-600/15 text-emerald-300 border-emerald-600/30",
};

export function TrackDiagLog({ onHide }: { onHide: () => void }) {
  const [events, setEvents] = useState<GeoDiagEvent[]>(() => getTrackLog());
  const [shell, setShell] = useState<ShellDiagReport>({ events: [], device: "", verdict: "" });
  const refreshShell = () => { void readShellLog().then(setShell); };
  useEffect(() => { let live = true; void readShellLog().then(r => { if (live) setShell(r); }); return () => { live = false; }; }, []);
  const refresh = () => { setEvents(getTrackLog()); refreshShell(); };
  const wipe = () => { clearTrackLog(); setEvents(getTrackLog()); };
  const copy = () => { try { navigator.clipboard?.writeText(JSON.stringify(events, null, 2)); } catch { /* ignore */ } };
  const hide = () => onHide();

  const s = summarize(events);
  const hr = summarizeHr(events);
  const rows = [...events].reverse(); // newest first

  return (
    <>
    <ShellSection report={shell} onRefresh={refreshShell} />
    <div className="space-y-2 pt-3 mt-1 border-t border-slate-700/60">
      <div className="flex items-center gap-2">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide flex-1">Sensor log — GPS + HR (dev)</p>
        <button type="button" aria-label="Refresh GPS log" onClick={refresh} className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300"><RefreshCw size={13} /></button>
        <button type="button" aria-label="Copy GPS log as JSON" onClick={copy} className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300"><Copy size={13} /></button>
        <button type="button" aria-label="Clear GPS log" onClick={wipe} className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300"><Trash2 size={13} /></button>
        <button type="button" aria-label="Hide GPS developer log" onClick={hide} className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300"><EyeOff size={13} /></button>
      </div>
      <p className="text-[11px] text-slate-500 -mt-1">
        Fix and heart-beat stream for recent runs. Enabled now — do a run with the screen off, then
        Refresh. A big "max gap while hidden" versus a small "while visible" means fixes stop when the
        screen is off. For HR, "delivery stalls" means the strap kept beating and this app stopped being
        fed; "link dead" means the strap really dropped; "scans throttled" means Android refused the
        re-discovery that would have got it back.
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-300">
        <span>fixes hidden: <b className="text-amber-300">{s.hiddenFixes}</b> · visible: <b className="text-emerald-300">{s.visibleFixes}</b></span>
        <span>max gap hidden: <b className={s.maxHidden > 60000 ? "text-rose-400" : "text-slate-200"}>{(s.maxHidden / 1000).toFixed(0)}s</b> · visible: <b className="text-slate-200">{(s.maxVisible / 1000).toFixed(0)}s</b></span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-300">
        <span>beats delivered: <b className="text-pink-300">{hr.beats}</b></span>
        <span>delivery stalls: <b className={hr.deliveryStalls ? "text-amber-300" : "text-slate-200"}>{hr.deliveryStalls}</b></span>
        <span>link dead: <b className={hr.deadLink ? "text-rose-400" : "text-slate-200"}>{hr.deadLink}</b></span>
        <span>peer drops: <b className={hr.peerDrops ? "text-rose-400" : "text-slate-200"}>{hr.peerDrops}</b></span>
        <span>reconnect fails: <b className={hr.connectFails ? "text-rose-400" : "text-slate-200"}>{hr.connectFails}</b></span>
        <span>scans throttled: <b className={hr.scansThrottled ? "text-rose-400" : "text-slate-200"}>{hr.scansThrottled}</b></span>
      </div>
      {hr.power && <p className="text-[11px] text-slate-300">power regime: <b className="text-cyan-300">{hr.power}</b></p>}
      {hr.save && <p className="text-[11px] leading-snug rounded-lg bg-slate-900/60 border border-slate-700 px-2.5 py-2 text-slate-200">HR at save: {hr.save}</p>}
      {rows.length === 0
        ? <p className="text-xs text-slate-500 py-2">No events yet. Logging is on — start a run (ideally with the screen off partway), then Refresh.</p>
        : <div className="max-h-96 overflow-y-auto">{rows.map((e, i) => <EventRow key={`${e.at}-${i}`} e={e} />)}</div>}
    </div>
    </>
  );
}
