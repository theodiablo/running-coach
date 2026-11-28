// The share builder's daily counter (share_card_count) plus the consent-gated PostHog events.
// The counter is non-personal by construction, so it counts every runner without consent:
// docs/telemetry.md ("Non-personal server counters"), docs/share-card.md ("Analytics").
import { supabase } from "../supabase";
import { platform } from "../native";
import { track } from "../telemetry";
import type { CardStyle } from "./cardModel";

export type ShareEntry = "finish" | "detail";
type Handoff = "shared" | "saved";

type Row =
  | { event: "opened"; entry: ShareEntry; preselected: CardStyle }
  | { event: Handoff | "closed"; entry: ShareEntry; preselected: CardStyle; chosen: CardStyle; first_share: boolean };

const sharePlatform = (): "web" | "ios" | "android" => (platform === "ios" || platform === "android" ? platform : "web");

// Best-effort: a failed count is dropped, never retried or surfaced.
function bump(row: Row) {
  try {
    const args = {
      p_event: row.event, p_entry: row.entry, p_preselected: row.preselected, p_platform: sharePlatform(),
      p_chosen: row.event === "opened" ? null : row.chosen, p_first_share: row.event === "opened" ? null : row.first_share,
    };
    void supabase.rpc("share_card_count", args)
      .then(({ error }) => { if (error) console.warn("share_card_count failed", error.message); }, () => {});
  } catch {
    /* counting must never break sharing */
  }
}

export function shareOpened(entry: ShareEntry, preselected: CardStyle) {
  bump({ event: "opened", entry, preselected });
  track("share_card_opened", { entry, preselected });
}

export function shareHandedOff(event: Handoff, entry: ShareEntry, preselected: CardStyle, chosen: CardStyle, firstShare: boolean) {
  bump({ event, entry, preselected, chosen, first_share: firstShare });
  track("share_card_shared", { entry, preselected, chosen, event });
}

// Only for a visit that handed nothing off: `chosen` is the style on screen when it closed.
export function shareClosed(entry: ShareEntry, preselected: CardStyle, chosen: CardStyle) {
  bump({ event: "closed", entry, preselected, chosen, first_share: false });
}
