import { registerPlugin } from "@capacitor/core";
import { isAndroid, nativeBuildLabel, platform } from "../native";
import { supabase } from "../supabase";
import { currentUserId } from "../db";
import { getTrackLog, isGeoDebugEnabled } from "../geo/trackLog";

// Reads the shell diagnostics the Android side records (ShellDiagLog.kt) — the
// half of the story the JS GPS log cannot tell.
//
// `logTrack` is JS writing to localStorage, so when the WebView renderer dies
// the log simply STOPS. A stopped log looks identical whether the renderer was
// reclaimed, the whole process was killed, or JS was merely frozen and later
// resumed — three very different bugs. The native log is written from
// MainActivity's lifecycle callbacks and from onRenderProcessGone, so it
// survives all three and says which one happened.
//
// Android-only and best-effort: an older shell has no plugin and simply
// resolves nothing.

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
 * Read the most recent backgrounded stretch and say what happened to the app in
 * it. This is the whole point of the log, so it is stated in words rather than
 * left for someone to reconstruct from timestamps at the moment they are least
 * able to (a run has just been lost).
 *
 * Exported pure and tested — the three shapes it distinguishes are the three
 * competing explanations for a recorder that comes back frozen.
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
    return `The whole app PROCESS was killed — it cold-booted ${away(created.at)} with no renderer-gone before it. `
      + "Recording stopped there; the run is only as complete as the recovery buffer and journal.";
  }
  return "Nothing died while backgrounded: JS was frozen and resumed. A freeze reported here is something else.";
}

function findLast(events: ShellDiagEvent[], match: (e: ShellDiagEvent) => boolean): number {
  for (let i = events.length - 1; i >= 0; i--) if (match(events[i])) return i;
  return -1;
}

// ── filing a report ────────────────────────────────────────────────────────

/**
 * File the current diagnostics to `shell_diagnostics`, so a session that went
 * wrong can be read afterwards instead of reconstructed from memory.
 *
 * **Opt-in and gated on the hidden developer log**, never on a normal install:
 * this is a debugging channel, not telemetry, and telemetry has its own consent
 * seam (docs/telemetry.md). Contains no location — the shell log is lifecycle
 * kinds and memory numbers, and the GPS log stores fix metadata (arrival time,
 * accuracy radius, drop reason) but no coordinates.
 *
 * Best-effort in every direction: signed out, offline or a missing table all
 * resolve false rather than throwing at a caller who is already dealing with a
 * failure.
 */
export async function fileShellReport(note?: string): Promise<boolean> {
  if (!isGeoDebugEnabled()) return false;
  const user_id = currentUserId();
  if (!user_id) return false;
  try {
    const report = await readShellLog();
    // Nothing to say and nothing to correlate it with — don't file an empty row.
    const track = getTrackLog();
    if (!report.events.length && !track.length) return false;
    const { error } = await supabase.from("shell_diagnostics").insert({
      user_id,
      platform,
      app_version: nativeBuildLabel() || null,
      device: report.device || null,
      verdict: report.verdict || null,
      events: report.events,
      track,
      ...(note ? { note } : {}),
    });
    return !error;
  } catch {
    return false;
  }
}

// Newest native event timestamp already filed, so a return to the foreground
// with nothing new to say doesn't file a duplicate every time the screen wakes.
const LAST_FILED_KEY = "rc_shell_diag_filed_at";
const readLastFiled = (): number => {
  try { return Number(localStorage.getItem(LAST_FILED_KEY)) || 0; } catch { return 0; }
};
const writeLastFiled = (at: number) => {
  try { localStorage.setItem(LAST_FILED_KEY, String(at)); } catch { /* non-fatal */ }
};

async function fileIfNew(reason: string): Promise<void> {
  const report = await readShellLog();
  const newest = report.events.reduce((max, e) => (e.at > max ? e.at : max), 0);
  if (newest && newest <= readLastFiled()) return; // nothing happened since the last report
  if (await fileShellReport(reason)) writeLastFiled(newest);
}

/**
 * Arm automatic filing. Nothing to press, and nothing to remember to press —
 * the whole point is that the report exists for a failure nobody was expecting.
 *
 * Two triggers, covering the two ways a session ends badly:
 *
 *  • **Boot.** Whatever killed the last session is by definition no longer
 *    running, and the native log is sitting there describing it. This is the
 *    one that catches a killed process and (since a background renderer death
 *    now forces a relaunch on the next foreground) a reclaimed renderer too.
 *  • **Return to the foreground.** Catches the case where nothing was killed
 *    at all — the app came back by itself — which is a different bug and needs
 *    to be told apart from the other two rather than going unreported.
 *
 * Gated on the hidden developer log, deduped on the newest native event, and
 * best-effort throughout. Returns its own teardown.
 */
export function armShellReporting(): () => void {
  if (!isGeoDebugEnabled()) return () => {};
  void fileIfNew("auto: app boot").catch(() => { /* best-effort */ });
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    void fileIfNew("auto: returned to foreground").catch(() => { /* best-effort */ });
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => document.removeEventListener("visibilitychange", onVisible);
}
