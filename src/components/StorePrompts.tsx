import { useEffect } from "react";
import { isNative } from "../native";
import { startPlayUpdate, type ReviewChannel } from "../storeBridge";
import { isStoreReconciled } from "../db";
import { track } from "../telemetry";
import { ymd } from "../utils/format";
import {
  nextPlayPromptRecord, nextReviewAsk, playPromptDue, reviewCardDue, type PlayPromptRecord,
} from "../utils/storePrompts";
import type { AppUpdate } from "../utils/version";
import type { ReviewPromptState, Run } from "../types";
import { PLAY_UPDATE_PROMPT_KEY } from "../constants";

// Times the store prompts, only when Home is calm: never over a recorder, a modal
// or another one-time sheet. Play's update dialog opens here; the review card is
// handed to Home. Renders nothing.
export const STORE_PROMPT_DELAY_MS = 1500;

const notStarted = (status: string) => status === "unknown" || status === "failed" || status === "canceled";

function readPlayPrompt(): PlayPromptRecord | null {
  try {
    const v = JSON.parse(localStorage.getItem(PLAY_UPDATE_PROMPT_KEY) || "null");
    return v && typeof v.code === "number" ? v : null;
  } catch { return null; }
}

function writePlayPrompt(rec: PlayPromptRecord) {
  try { localStorage.setItem(PLAY_UPDATE_PROMPT_KEY, JSON.stringify(rec)); } catch { /* asks again next launch */ }
}

export function StorePrompts({ calm, update, runs, reviewChannel, reviewState, reviewMoment, onMomentSpent }: {
  calm: boolean;
  reviewChannel: ReviewChannel | null;
  update: AppUpdate | null;
  runs: Run[];
  reviewState: ReviewPromptState | undefined;
  reviewMoment: boolean;
  onMomentSpent: (ask: number | null) => void;
}) {
  const playCode = update?.via === "play" && notStarted(update.status) ? update.versionCode : null;
  const today = ymd(new Date());
  const playRecord = readPlayPrompt();
  const playDue = playCode != null && playPromptDue(playCode, playRecord, today);

  useEffect(() => {
    if (!calm || !playDue || playCode == null) return;
    const id = setTimeout(() => {
      writePlayPrompt(nextPlayPromptRecord(playCode, readPlayPrompt(), ymd(new Date())));
      void startPlayUpdate(false).then((outcome) => track("app_update_prompted", { outcome: outcome ?? "unavailable" }));
    }, STORE_PROMPT_DELAY_MS);
    return () => clearTimeout(id);
  }, [calm, playDue, playCode]);

  // A run just saved is the moment, spent on the first calm Home after it whether
  // or not anything shows. Never while an update is pending or on a day Play's
  // dialog was offered, and only on the synced copy of the log.
  const reviewDue = isNative && reviewMoment && !!reviewChannel && !update && playRecord?.at !== today
    && isStoreReconciled() && reviewCardDue({ runs, state: reviewState, today });
  const ask = nextReviewAsk(reviewState);
  useEffect(() => {
    if (!calm || !reviewMoment) return;
    const id = setTimeout(() => onMomentSpent(reviewDue ? ask : null), STORE_PROMPT_DELAY_MS);
    return () => clearTimeout(id);
  }, [calm, reviewMoment, reviewDue, ask, onMomentSpent]);

  return null;
}
