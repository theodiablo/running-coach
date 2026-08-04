// The live/paused/ended state of a watched run — a pure function of the row,
// shared by LiveWatchView's body and each caller's header chrome (the watch
// modal, the public page) so the two can never disagree about whether the run
// is live.
import type { PublicLiveRun } from "./shareLink";

export const liveWatchDotState = (run: PublicLiveRun | null): { ended: boolean; paused: boolean } => ({
  ended: !run || run.status === "ended",
  paused: run?.status === "paused",
});
