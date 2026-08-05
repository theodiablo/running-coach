// Watch a run that is happening right now, from another of the runner's own
// signed-in sessions. Read-only: everything here comes from the `live_runs` row
// that the recording phone upserts (see src/live/publisher.ts).
//
// The display itself — map, stats, and the deliberately careful staleness copy
// — is LiveWatchView, shared with the public /watch/:token page. This file is
// only the modal chrome around it.

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

  // Hold the Stop snapshot (status "ended", full trace) so the row's deletion a
  // moment later — the runner saving the run — doesn't blank an open modal into
  // an empty map. Only an explicit "ended" is held: a row that vanishes while
  // live was swept as leftover, and keeping it would be a guess. Render-time
  // reconcile, per the derived-state convention (no setState in effects).
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
