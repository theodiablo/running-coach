import { useEffect } from "react";
import { isNative } from "../native";
import { requestStoreReview, startPlayUpdate } from "../storeBridge";
import { track } from "../telemetry";
import { ymd } from "../utils/format";
import {
  nextPlayPromptRecord, playPromptDue, reviewPromptDue, type PlayPromptRecord,
} from "../utils/storePrompts";
import type { AppUpdate } from "../utils/version";
import type { Run, SettingsState } from "../types";
import { PLAY_UPDATE_PROMPT_KEY } from "../constants";

// Opens the stores' own sheets, and only when Home is calm: never over a
// recorder, a modal or another one-time sheet. Renders nothing.
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

export function StorePrompts({ calm, update, runs, reviewAsks, reviewMoment, onMomentSpent }: {
  calm: boolean;
  update: AppUpdate | null;
  runs: Run[];
  reviewAsks: string[] | undefined;
  reviewMoment: boolean;
  onMomentSpent: (patch: Partial<SettingsState> | null) => void;
}) {
  const playCode = update?.via === "play" && notStarted(update.status) ? update.versionCode : null;
  const today = ymd(new Date());
  const playDue = playCode != null && playPromptDue(playCode, readPlayPrompt(), today);

  useEffect(() => {
    if (!calm || !playDue || playCode == null) return;
    const id = setTimeout(() => {
      writePlayPrompt(nextPlayPromptRecord(playCode, readPlayPrompt(), ymd(new Date())));
      void startPlayUpdate(false).then((outcome) => track("app_update_prompted", { outcome: outcome ?? "unavailable" }));
    }, STORE_PROMPT_DELAY_MS);
    return () => clearTimeout(id);
  }, [calm, playDue, playCode]);

  // A run just saved is the moment, spent on the first calm Home after it whether
  // or not a sheet goes out. One store sheet per moment: an update offer goes first.
  const reviewDue = isNative && reviewMoment && !playDue && reviewPromptDue({ runs, asks: reviewAsks, today });
  useEffect(() => {
    if (!calm || !reviewMoment) return;
    const id = setTimeout(() => {
      if (!reviewDue) return onMomentSpent(null);
      onMomentSpent({ reviewAsks: [...(reviewAsks ?? []), ymd(new Date())].slice(-5) });
      void requestStoreReview().then((asked) => { if (asked) track("review_requested", {}); });
    }, STORE_PROMPT_DELAY_MS);
    return () => clearTimeout(id);
  }, [calm, reviewMoment, reviewDue, reviewAsks, onMomentSpent]);

  return null;
}
