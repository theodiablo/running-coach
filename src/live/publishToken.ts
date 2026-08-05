// The per-run publish token — the WRITE capability behind native screen-off
// uploads (docs/live-sharing.md, "Native screen-off uploads").
//
// Mirror of shareLink.ts's token half, for the second capability: same shape,
// same entropy, same per-device storage semantics. Unlike the share token it
// is never displayed and never leaves the device except inside the writes it
// authorizes, so there is no URL/mint-UI half here.

import { LIVE_PUBLISH_TOKEN_KEY } from "../constants";
import { SHARE_TOKEN_BYTES, toBase64Url } from "./shareLink";
// @ts-expect-error Shared Deno/Vitest ESM has no TypeScript declaration file.
import * as sharedLivePublish from "../../supabase/functions/_shared/livePublish.mjs";

type LivePublishExports = {
  PUBLISH_TOKEN_RE: RegExp;
  PUBLISH_MAX_POINTS: number;
  isValidPublishToken: (value: unknown) => boolean;
  isValidPointBatch: (points: unknown) => boolean;
  sanitizeStats: (stats: unknown) => {
    km: number | null; durationSec: number | null; avgPace: number | null; curPace: number | null;
  };
};
const shared = sharedLivePublish as LivePublishExports;

export const { PUBLISH_TOKEN_RE, PUBLISH_MAX_POINTS, isValidPublishToken, isValidPointBatch, sanitizeStats } = shared;

// 128 bits from the CSPRNG, like mintShareToken. Never Math.random().
export function mintPublishToken(): string {
  const bytes = new Uint8Array(SHARE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

// Per-device storage, same lifecycle as the share token: survives an app kill
// (a recovered run keeps writing under the row it opened), spent by
// endLiveRun/sweepOwnLiveRun, deliberately NOT cleared by resetLivePublisher.
export const readPublishToken = (): string | null => {
  try {
    const v = localStorage.getItem(LIVE_PUBLISH_TOKEN_KEY);
    return isValidPublishToken(v) ? v : null;
  } catch { return null; }
};

export const storePublishToken = (token: string | null): void => {
  try {
    if (token) localStorage.setItem(LIVE_PUBLISH_TOKEN_KEY, token);
    else localStorage.removeItem(LIVE_PUBLISH_TOKEN_KEY);
  } catch { /* quota — the token just won't survive a restart */ }
};
