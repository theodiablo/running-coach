// Watch a run happening now from another of the runner's own signed-in sessions. Read-only:
// everything comes from the `live_runs` row the recording phone upserts
// (src/live/publisher.ts). The display is LiveWatchView, shared with the public /watch/:token
// page; this file is only the modal chrome.

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { LiveWatchDot, LiveWatchView, type LiveWatchStatus } from "../components/LiveWatchView";
import { useDismissable } from "../hooks/useDismissable";
import type { LiveRunRow } from "../live/publisher";

type LiveWatchModalProps = {
  row: LiveRunRow | null;
  onClose: () => void;
};

export function LiveWatchModal({ row, onClose }: LiveWatchModalProps) {
  const { t } = useTranslation();
  useDismissable(true, onClose);
  const [status, setStatus] = useState<LiveWatchStatus | null>(null);
  // Stable identity so reporting the status can't loop the effect that reports it.
  const onStatus = useCallback((s: LiveWatchStatus) => setStatus(s), []);

  // Hold the Stop snapshot ("ended", full trace) so the row's deletion a moment later doesn't
  // blank an open modal. Only an explicit "ended" is held: a row that vanishes while live was
  // swept, and keeping it would be a guess. Render-time reconcile (no setState in effects).
  const [prevRow, setPrevRow] = useState<LiveRunRow | null>(row);
  const [held, setHeld] = useState<LiveRunRow | null>(row?.status === "ended" ? row : null);
  if (row !== prevRow) {
    setPrevRow(row);
    if (row) setHeld(row.status === "ended" ? row : null);
  }
  const shown = row ?? held;

  return (
    <div className="fixed inset-0 bg-slate-900 z-50 flex flex-col animate-slide-up">
      <header className="flex items-center justify-between px-4 border-b border-slate-800"
        style={{ height: "calc(44px + var(--safe-top))", paddingTop: "var(--safe-top)" }}>
        <div className="flex items-center gap-1.5">
          <LiveWatchDot ended={status?.ended ?? !shown} paused={status?.paused ?? false} />
          <span className="text-sm font-semibold">{t("liveShare.watch.title")}</span>
        </div>
        <button onClick={onClose} aria-label={t("common.close")}
          className="text-slate-400 hover:text-white p-1.5"><X size={18} /></button>
      </header>

      <LiveWatchView run={shown} onStatus={onStatus} />
    </div>
  );
}
