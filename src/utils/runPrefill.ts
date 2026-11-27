import type { HrPending, Run } from "../types";
import type { SessionWithWeek } from "./overdue";
import type { TrackPointOrGap } from "./geo";

// What a hand-off to the log carries: the run so far, plus how it got there.
export type RunPrefill = Partial<Run> & {
  pace?: number;
  // The plan session this save settles, as a whole row, so the pairing can be re-checked against edits.
  session?: SessionWithWeek | null;
  // The app matched that session (src/utils/sessionMatch.ts) rather than the runner picking it: an offer, declinable.
  sessionOffered?: boolean;
  hrPending?: HrPending | null;
  // The recorder's finish screen already showed this run's best efforts.
  celebrated?: boolean;
  // The recorder's own trace, for the review's route line (never saved on the run; carryPrefill drops it).
  previewTrack?: readonly TrackPointOrGap[];
};

// A device measured this run, so it is reviewed (RunReview), not typed in (LogView).
export const isRecordedArrival = (p: RunPrefill | null | undefined) =>
  p?.source === "gps" || p?.source === "indoor" || p?.source === "watch";
