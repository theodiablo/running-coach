import { useState } from "react";
import { RefreshCw, Trash2, Copy, ChevronDown, ChevronRight, EyeOff } from "lucide-react";
import { getScanLog, clearScanLog, type ScanLogEntry, type ScanLogSession } from "../watch/scanLog";

// Hidden developer diagnostics for watch import (revealed from Settings →
// Integrations by tapping the section title). Shows what each Health Connect scan
// returned and why every session was kept or dropped — the tool for "my Zepp run
// didn't import" / "its elevation is blank". Deliberately raw and English-only
// (type ids, package names): it is a debug surface, not a user feature, so it is
// not wired through i18n.

const EX_TYPE: Record<number, string> = {
  56: "running", 57: "treadmill", 79: "walking", 37: "hiking",
  8: "biking", 82: "swim (pool)", 84: "swim (open water)",
};
const exLabel = (t?: number) => (t == null ? "—" : `${EX_TYPE[t] || "other"} (${t})`);

const OUTCOME_CLS: Record<string, string> = {
  imported: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  "not-run-type": "bg-slate-600/30 text-slate-300 border-slate-500/40",
  "too-short": "bg-amber-500/15 text-amber-300 border-amber-500/30",
  "already-seen": "bg-slate-600/30 text-slate-400 border-slate-500/40",
  duplicate: "bg-slate-600/30 text-slate-400 border-slate-500/40",
  invalid: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

const km = (m?: number | null) => (m == null ? "no distance" : `${(m / 1000).toFixed(2)} km`);
const elev = (m?: number | null) => (m == null ? "no elevation" : `${Math.round(m)} m`);
const when = (ms: number) => { try { return new Date(ms).toLocaleString(); } catch { return String(ms); } };

function SessionRow({ s }: { s: ScanLogSession }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 border-t border-slate-700/40 text-[11px]">
      <span className={`px-1.5 py-0.5 rounded border font-semibold ${OUTCOME_CLS[s.outcome] || OUTCOME_CLS.invalid}`}>{s.outcome}</span>
      <span className="text-slate-300">{exLabel(s.exerciseType)}</span>
      <span className="text-slate-400">{km(s.distanceM)}</span>
      <span className={s.elevationGainM == null ? "text-amber-400" : "text-slate-400"}>{elev(s.elevationGainM)}</span>
      {s.hrAvg != null && <span className="text-slate-400">{s.hrAvg} bpm</span>}
      {s.dataOrigin && <span className="text-slate-500 basis-full truncate">{s.dataOrigin}</span>}
    </div>
  );
}

// Why the imported runs did or didn't get a map. Exercise routes are a separate
// Health Connect grant the app can't ask for, so "consent" here is the expected
// default rather than a fault — this line is what makes that visible on-device.
const ROUTE_LABEL: Record<string, string> = {
  data: "route",
  "consent-required": "no route consent",
  none: "no route written",
  unavailable: "route read failed",
};

function routeSummary(e: ScanLogEntry): string {
  const statuses = e.routeStatuses;
  if (!statuses?.length) return e.routesGranted ? "routes allowed" : "";
  const counts = new Map<string, number>();
  for (const s of statuses) counts.set(s, (counts.get(s) || 0) + 1);
  const per = [...counts].map(([s, n]) => `${n} ${ROUTE_LABEL[s] || s}`).join(", ");
  // Whether the grant exists is the other half of the answer: "no route written"
  // means something quite different with routes allowed than without.
  return e.routesGranted ? `${per} · routes allowed` : per;
}

function EntryCard({ e }: { e: ScanLogEntry }) {
  const [open, setOpen] = useState(false);
  const problem = e.availability !== "Available" || !e.permission || !!e.error;
  return (
    <div className="rounded-xl bg-slate-800/60 border border-slate-700/60 px-3 py-2">
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 text-left">
        {e.sessions.length ? (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span className="w-[14px]" />}
        <div className="flex-1 min-w-0">
          <div className="text-xs text-slate-300">{when(e.at)} · <span className="text-slate-400">{e.trigger}</span> · {e.days}d</div>
          <div className="text-[11px] text-slate-400">
            {e.rawCount} session{e.rawCount === 1 ? "" : "s"} → <span className="text-emerald-300">{e.importedCount} imported</span>
            {routeSummary(e) && <> · <span className="text-slate-400">{routeSummary(e)}</span></>}
          </div>
        </div>
        {problem && (
          <span className="text-[10px] px-1.5 py-0.5 rounded border bg-rose-500/15 text-rose-300 border-rose-500/30 shrink-0">
            {e.error ? "error" : e.availability !== "Available" ? e.availability : "no permission"}
          </span>
        )}
      </button>
      {e.error && <p className="text-[11px] text-rose-300 mt-1 break-words">{e.error}</p>}
      {open && e.sessions.map(s => <SessionRow key={s.id} s={s} />)}
    </div>
  );
}

export function WatchSyncLog({ onHide }: { onHide: () => void }) {
  const [entries, setEntries] = useState<ScanLogEntry[]>(() => getScanLog());
  const refresh = () => setEntries(getScanLog());
  const wipe = () => { clearScanLog(); refresh(); };
  const copy = () => { try { navigator.clipboard?.writeText(JSON.stringify(entries, null, 2)); } catch { /* ignore */ } };
  const hide = () => onHide();

  const rows = [...entries].reverse();

  return (
    <div className="space-y-2 pt-3 mt-1 border-t border-slate-700/60">
      <div className="flex items-center gap-2">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide flex-1">Watch sync log (dev)</p>
        <button type="button" aria-label="Refresh log" onClick={refresh} className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300"><RefreshCw size={13} /></button>
        <button type="button" aria-label="Copy log as JSON" onClick={copy} className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300"><Copy size={13} /></button>
        <button type="button" aria-label="Clear log" onClick={wipe} className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300"><Trash2 size={13} /></button>
        <button type="button" aria-label="Hide developer log" onClick={hide} className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300"><EyeOff size={13} /></button>
      </div>
      <p className="text-[11px] text-slate-500 -mt-1">
        Every Health Connect scan and why each session was kept or dropped. An imported run with an amber
        "no elevation" means the watch app never wrote elevation to Health Connect (nothing the app can recover).
      </p>
      {rows.length === 0
        ? <p className="text-xs text-slate-500 py-2">No scans recorded yet. Open or re-open the app with the watch connected, then Refresh.</p>
        : <div className="space-y-2">{rows.map((e, i) => <EntryCard key={`${e.at}-${i}`} e={e} />)}</div>}
    </div>
  );
}
