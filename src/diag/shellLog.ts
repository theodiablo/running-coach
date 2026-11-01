import { registerPlugin } from "@capacitor/core";
import { isAndroid, nativeBuildLabel, platform } from "../native";
import { supabase } from "../supabase";
import { currentUserId } from "../db";
import { getTrackLog, isGeoDebugEnabled } from "../geo/trackLog";

// Reads the shell diagnostics the Android side records (ShellDiagLog.kt). The JS GPS log
// just STOPS when the renderer dies, identically for renderer reclaimed, process killed
// or JS frozen; the native log (MainActivity lifecycle, onRenderProcessGone) survives all
// three and says which. Android-only, best-effort: an older shell resolves nothing.

type ShellDiagEvents = { events?: ShellDiagEvent[]; device?: string };

const ShellDiag = registerPlugin<{
  getEvents: () => Promise<ShellDiagEvents>;
  clear: () => Promise<void>;
}>("ShellDiag");

export type ShellDiagEvent = {
  at: number;        // epoch ms
  kind: string;      // create | foreground | background | renderer-gone | rebuild-deferred | rebuild | renderer-loop-guard
  detail?: string;   // didCrash / memory snapshot / what was done
};

export type ShellDiagReport = {
  events: ShellDiagEvent[];
  device: string;
  // What the timeline says died, if anything — the one question the JS log
  // can't answer. See verdictFor.
  verdict: string;
};

/**
 * Read the native shell log, newest event last. Never throws; an empty report
 * off Android or from a shell without the plugin.
 */
export async function readShellLog(): Promise<ShellDiagReport> {
  if (!isAndroid) return { events: [], device: "", verdict: "" };
  try {
    const res = await ShellDiag.getEvents();
    const events = Array.isArray(res?.events) ? res.events : [];
    return { events, device: res?.device || "", verdict: verdictFor(events) };
  } catch {
    return { events: [], device: "", verdict: "" };
  }
}

export function clearShellLog(): void {
  if (!isAndroid) return;
  ShellDiag.clear().catch(() => { /* best-effort */ });
}

/**
 * Say in words what happened to the app in the last backgrounded stretch. Pure and tested.
 */
export function verdictFor(events: ShellDiagEvent[]): string {
  const lastBackground = findLast(events, e => e.kind === "background");
  if (lastBackground < 0) return "No backgrounded stretch recorded yet.";
  const after = events.slice(lastBackground + 1);
  const gone = after.find(e => e.kind === "renderer-gone");
  const created = after.find(e => e.kind === "create");
  const away = (at: number) => `${Math.round((at - events[lastBackground].at) / 1000)}s after the app was backgrounded`;

  if (gone) {
    const crashed = /didCrash=true/.test(gone.detail || "");
    return `The WebView renderer ${crashed ? "CRASHED" : "was reclaimed by the OS"} ${away(gone.at)}. `
      + "The app process survived, so recording carried on natively — the run should be in the fix journal. "
      + (gone.detail ? `(${gone.detail})` : "");
  }
  if (created) {
    // `cold` vs `restored` is recorded natively (savedInstanceState == null) for
    // this decision alone, and reading past it turned every activity recreation
    // — a theme change, a locale change, a rotation — into "the process was
    // killed", the most alarming verdict this can give.
    if (/cold/.test(created.detail || "")) {
      return `The whole app PROCESS was killed — it cold-booted ${away(created.at)} with no renderer-gone before it. `
        + "Recording stopped there; the run is only as complete as the recovery buffer and journal.";
    }
    // Ambiguous by construction: Android restores saved instance state both
    // after a configuration change (process alive) and after a background
    // process death. Say so rather than pick one — the GPS log settles it.
    return `The ACTIVITY was recreated ${away(created.at)} with saved state and no renderer-gone before it. `
      + "That is usually a configuration change with the process alive, but Android also restores saved state "
      + "after a background process death — check whether the GPS log kept advancing across it.";
  }
  return "Nothing died while backgrounded: JS was frozen and resumed. A freeze reported here is something else.";
}

function findLast(events: ShellDiagEvent[], match: (e: ShellDiagEvent) => boolean): number {
  for (let i = events.length - 1; i >= 0; i--) if (match(events[i])) return i;
  return -1;
}

// ── filing a report ────────────────────────────────────────────────────────

/**
 * File the diagnostics to `shell_diagnostics`. Opt-in, gated on the hidden developer log (not
 * telemetry); no coordinates. Best-effort: resolves a reason rather than throwing.
 */
export type FileReportResult = "sent" | "not-armed" | "signed-out" | "empty" | "failed";

export async function fileShellReport(note?: string): Promise<FileReportResult> {
  if (!isGeoDebugEnabled()) return "not-armed";
  const user_id = currentUserId();
  if (!user_id) return "signed-out";
  try {
    const report = await readShellLog();
    // Nothing to say and nothing to correlate it with — don't file an empty row.
    const track = getTrackLog();
    if (!report.events.length && !track.length) return "empty";
    const { error } = await supabase.from("shell_diagnostics").insert({
      user_id,
      platform,
      app_version: nativeBuildLabel() || null,
      device: report.device || null,
      verdict: report.verdict || null,
      events: report.events,
      track,
      note: note || null,
    });
    return error ? "failed" : "sent";
  } catch {
    return "failed";
  }
}

