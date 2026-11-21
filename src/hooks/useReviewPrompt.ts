import { useCallback, useRef, useState } from "react";
import { openStoreReview, requestStoreReview, type ReviewChannel } from "../storeBridge";
import { track } from "../telemetry";
import { ymd } from "../utils/format";
import { withReviewSeen } from "../utils/storePrompts";
import type { ReviewAnswer } from "../components/ReviewCard";
import type { ReviewPromptState } from "../types";

type Patch = (f: (s: ReviewPromptState | undefined) => ReviewPromptState | undefined) => void;

// The hub's side of the review ask (docs/release.md, "Store prompts"): the moment a
// fresh run arms, what StorePrompts does with it per channel, and the card's answers.
export function useReviewPrompt(channel: ReviewChannel | null, patch: Patch) {
  const [moment, setMoment] = useState(false);
  const [ask, setAsk] = useState<number | null>(null);
  // Idempotent per ask: Home remounts on every tab switch while the card waits.
  const markSeen = useCallback((n: number) => patch(s => withReviewSeen(s, ymd(new Date()), n)), [patch]);
  const done = useCallback((d: "review" | "never") => patch(s => ({ ...s, done: d })), [patch]);

  const spendMoment = useCallback((n: number | null) => {
    setMoment(false);
    if (!n) return;
    if (channel?.prompt === "card") { setAsk(n); return; }
    markSeen(n);
    void requestStoreReview().then(asked => { if (asked) track("review_requested", { ask: n }); });
  }, [channel, markSeen]);

  const seenAsk = useRef(0);
  const onSeen = useCallback(() => {
    if (!ask || seenAsk.current === ask) return;
    seenAsk.current = ask;
    markSeen(ask);
    track("review_card_shown", { ask });
  }, [ask, markSeen]);

  const onAnswer = useCallback((answer: ReviewAnswer) => {
    track("review_card_answered", { answer, ask: ask ?? 0 });
    setAsk(null);
    if (answer === "never") done("never");
    if (answer === "review") void openStoreReview().then(ok => { if (ok) done("review"); });
  }, [ask, done]);

  // The Settings row: a review written from there ends the Home asks too.
  const rateFromSettings = useCallback(() => {
    void openStoreReview().then(ok => { if (ok) done("review"); });
  }, [done]);

  return {
    moment,
    armMoment: useCallback(() => setMoment(true), []),
    spendMoment,
    card: ask ? { ask, onSeen, onAnswer } : null,
    rateFromSettings,
  };
}
