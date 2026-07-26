import { supabase } from "../../supabase";
import { isNative, isIos } from "../../native";
import { WEB_APP_ORIGIN } from "../../constants";
import { parseActivityFile } from "../../utils/gpx";
import {
  POLAR_STATE_PREFIX, POLAR_NATIVE_STATE_PREFIX,
  POLAR_CODE_KEY, POLAR_RETURNED_STATE_KEY, POLAR_NONCE_KEY,
} from "../../polarPreinit";
import type { ImportProvider, ImportedRun } from "../types";

// Polar (AccessLink) cloud import. Secret half (OAuth exchange + exercise pull)
// lives in the `polar-import` edge function; this client starts the OAuth
// redirect and maps the returned exercises. Dormant until VITE_POLAR_CLIENT_ID
// is set. Architecture, OAuth return paths (web vs native): docs/integrations-polar.md.

const POLAR_CLIENT_ID = import.meta.env?.VITE_POLAR_CLIENT_ID as string | undefined;
const POLAR_AUTH_URL = "https://flow.polar.com/oauth2/authorization";
export const polarEnabled = !!POLAR_CLIENT_ID;

// Random per-connect nonce for the OAuth `state` (CSRF guard). crypto.randomUUID
// needs a secure context (prod/preview are https); the fallback is only a
// defensive last resort — the security property is that the value lives in this
// browser's sessionStorage and an attacker can't read or set it.
function newNonce(): string {
  try { if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID(); } catch { /* fall through */ }
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// Where Polar sends the browser back after authorization — must exactly match the
// redirect URL registered in the Polar app. The web app root; the return is
// detected by the `state` marker, so it never collides with Supabase's PKCE
// ?code=. On native this MUST be the canonical production origin, not
// window.location.origin (capacitor://localhost, unreachable and unregistered):
// the return lands on the web app, which bounces it to the deep link. The same
// value is passed again at exchange time — OAuth requires the token request's
// redirect_uri to equal the authorization request's byte-for-byte.
const redirectUri = () =>
  isNative ? WEB_APP_ORIGIN + "/" : (typeof window !== "undefined" ? window.location.origin + "/" : "");

// Storage seam for the OAuth handshake values. Web stashes in sessionStorage
// (per-tab, cleaned up with the tab); native must use localStorage because the
// OS can kill the app while the system browser is open — the cold-start
// relaunch via the deep link is a fresh WebView session and sessionStorage is
// gone (the CSRF nonce would be lost and every cold-start return would be
// rejected). Reads check both so one code path serves both platforms.
const readStash = (key: string): string | null => {
  try { const v = sessionStorage.getItem(key); if (v != null) return v; } catch { /* unavailable */ }
  try { return localStorage.getItem(key); } catch { return null; }
};
const clearStash = (key: string): void => {
  try { sessionStorage.removeItem(key); } catch { /* ignore */ }
  try { localStorage.removeItem(key); } catch { /* ignore */ }
};
const writeNonce = (nonce: string): void => {
  try {
    if (isNative) localStorage.setItem(POLAR_NONCE_KEY, nonce);
    else sessionStorage.setItem(POLAR_NONCE_KEY, nonce);
  } catch { /* storage unavailable — the return's state check will just fail closed */ }
};

// The exact state strings a return may carry for the nonce this device stored
// at connect() time (plain = web connect, :native: = native connect). Exported
// for tests.
export const expectedPolarStates = (nonce: string): string[] => [
  POLAR_STATE_PREFIX + ":" + nonce,
  POLAR_NATIVE_STATE_PREFIX + ":" + nonce,
];

type Invoke = { action: string; [k: string]: unknown };
async function invoke<T>(body: Invoke): Promise<T | null> {
  try {
    const { data, error } = await supabase.functions.invoke("polar-import", { body });
    if (error) return null;
    return data as T;
  } catch { return null; }
}

// Sports we import as runs (Polar `detailed-sport-info` / `sport`). Anything else
// (cycling, swimming…) is skipped. Walking/hiking → WALK, the rest → EASY.
const WALK_SPORTS = new Set(["WALKING", "HIKING", "NORDIC_WALKING"]);
const RUN_SPORTS = new Set(["RUNNING", "JOGGING", "TRAIL_RUNNING", "ROAD_RUNNING", "TREADMILL_RUNNING", "TRACK_AND_FIELD_RUNNING"]);

// ISO-8601 duration ("PT1H2M3S" / "PT45M30.5S") → seconds.
function parseIsoDuration(v: unknown): number {
  if (typeof v !== "string") return 0;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(v);
  if (!m) return 0;
  return Math.round((+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)));
}

type PolarExercise = { id: string; summary?: Record<string, unknown>; gpx?: string | null };

// One Polar exercise → an ImportedRun, or null when it isn't a run/walk. Prefer
// the GPX (full route + HR series via the shared parser); fall back to the JSON
// summary's totals for a routeless (indoor) exercise.
export function polarExerciseToRun(ex: PolarExercise): ImportedRun | null {
  const s = ex.summary || {};
  const sport = String(s["detailed-sport-info"] ?? s["sport"] ?? "").toUpperCase();
  const isWalk = WALK_SPORTS.has(sport);
  const isRun = RUN_SPORTS.has(sport);
  // If the sport is known and not a run/walk, skip; if unknown, allow (a GPX/
  // distance still makes it importable — the user can re-type it).
  if (sport && !isWalk && !isRun) return null;
  const type = isWalk ? "WALK" : "EASY";
  const extId = "polar:" + ex.id;
  const startedAt = typeof s["start-time"] === "string" ? (s["start-time"] as string) : undefined;

  if (ex.gpx) {
    const res = parseActivityFile(ex.gpx, "gpx");
    if ("run" in res && res.run) {
      // Keep the parser's startedAt: GPX times are UTC ("Z"-suffixed), the
      // authoritative instant. Do NOT overwrite it with the summary's
      // `start-time`, which is timezone-naive local time (no offset) and would
      // shift the epoch — breaking time-overlap dedupe against a CSV/GPX copy.
      return {
        ...res.run,
        type,
        source: "watch",
        notes: "Imported from Polar",
        extId,
      };
    }
    // GPX unparseable — fall through to the summary.
  }

  const km = Math.round((Number(s["distance"]) || 0) / 1000 * 100) / 100;
  if (km < 0.05) return null; // no usable distance and no route
  const durationSec = parseIsoDuration(s["duration"]) || 0;
  const hrObj = (s["heart-rate"] || {}) as Record<string, unknown>;
  const date = startedAt ? startedAt.slice(0, 10) : "";
  if (!date) return null;
  return {
    date,
    type,
    km,
    durationSec,
    hr: hrObj["average"] != null ? Math.round(Number(hrObj["average"])) : null,
    hrMax: hrObj["maximum"] != null ? Math.round(Number(hrObj["maximum"])) : null,
    effort: 5,
    source: "watch",
    notes: "Imported from Polar",
    extId,
    ...(startedAt ? { startedAt } : {}),
  };
}

// Kick off the OAuth authorization (full-page redirect on web, system browser
// on native). A per-connect nonce is saved so the return can be CSRF-validated.
// Completion happens on return via completePolarAuth() — at boot on web, and
// on the "rc-polar-return" deep-link event on native.
async function connect(): Promise<boolean | "pending"> {
  if (!polarEnabled || typeof window === "undefined") return false;
  const nonce = newNonce();
  writeNonce(nonce);
  const url = new URL(POLAR_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", POLAR_CLIENT_ID!);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("scope", "accesslink.read_all");
  url.searchParams.set("state", (isNative ? POLAR_NATIVE_STATE_PREFIX : POLAR_STATE_PREFIX) + ":" + nonce);
  if (isNative) {
    // The app itself stays alive under the external browser, so resolve
    // "pending": the caller drops its spinner without toasting, and the real
    // outcome arrives later via the deep-link event (or never, if the user
    // abandons the browser — in which case the row simply stays disconnected).
    if (isIos) {
      // SFSafariViewController — the OAuth pattern LoginScreen uses; App.tsx
      // closes it when the deep link lands.
      const { Browser } = await import("@capacitor/browser");
      await Browser.open({ url: url.toString() });
    } else {
      // Android: plain top-frame navigation. Capacitor's WebViewClient
      // intercepts the external host (Bridge.launchIntent) and hands it to the
      // OS as an ACTION_VIEW intent — the WebView never leaves the app. Never
      // use @capacitor/browser here (see openStore in UpdatePrompt.tsx).
      window.location.assign(url.toString());
    }
    return "pending";
  }
  window.location.assign(url.toString());
  // The page is navigating away to Polar; the real result only arrives on the
  // OAuth return (completePolarAuth at boot), so there is no boolean to give
  // here. Resolving false would make the settings panel flash a false
  // "access denied" toast on EVERY connect (the promise settles a microtask
  // before the browser unloads). So return a never-settling promise instead.
  // TRADE-OFF: if the navigation somehow never starts (assign blocked), the
  // connect spinner hangs — accepted, as that's far rarer than the
  // guaranteed false-error-on-every-connect the naive `return false` caused.
  return new Promise<boolean>(() => {});
}

// Outcome of a boot-time Polar OAuth return:
//   "idle"      — not a Polar return (normal load), a silently-handled denial,
//                 or a rejected state (CSRF). Caller does nothing.
//   "connected" — a token was just stored. Caller enables + scans.
//   "failed"    — the user authorized but the server-side exchange failed (bad
//                 code, Polar 5xx, network). Caller surfaces an error so the user
//                 isn't left staring at an unchanged "Connect" with no feedback.
export type PolarAuthResult = "idle" | "connected" | "failed";

// Called at app boot and (native) on the "rc-polar-return" deep-link event: if
// a Polar OAuth return was stashed — by polarPreinit on web (sessionStorage,
// after stripping the URL before Supabase could touch it) or by App.tsx's
// deep-link handler on native (localStorage) — validate the state against this
// device's connect-time nonce (CSRF guard), then exchange the code server-side
// for a stored token. A no-op on every normal load and when Polar is unconfigured.
export async function completePolarAuth(): Promise<PolarAuthResult> {
  if (!polarEnabled || typeof window === "undefined") return "idle";
  const code = readStash(POLAR_CODE_KEY);
  const returnedState = readStash(POLAR_RETURNED_STATE_KEY);
  const nonce = readStash(POLAR_NONCE_KEY);
  // One-shot ONLY when actually consuming a return: clear everything so a
  // reload can't replay the exchange. When no code is stashed, clear NOTHING —
  // on native a connect can still be in flight while the app boots (the OS
  // killed it under the system browser and something other than the deep link
  // relaunched it, or the boot ran before App.tsx finished stashing); wiping
  // the nonce then would reject the genuine return that's about to arrive.
  if (code) {
    clearStash(POLAR_CODE_KEY);
    clearStash(POLAR_RETURNED_STATE_KEY);
    clearStash(POLAR_NONCE_KEY);
  }
  // No code stashed → either a normal load (not a Polar return) OR the user
  // DENIED on Polar's page (the return carried ?error= and no code; polarPreinit
  // already stripped it from the URL). TRADE-OFF: a denial is handled silently
  // (returns "idle" → no toast). Deliberate: the denial has to be detected
  // pre-app-boot (in polarPreinit, before React/i18n exist), so surfacing a
  // localized "you cancelled" message would mean plumbing a flag from there into
  // the app just for the case where the user themselves chose to cancel — not
  // worth it. The visible outcome (still "Connect", clean URL) already reads as
  // "not connected". (This differs from a *failed exchange* below, which the
  // user didn't choose and so IS surfaced.)
  if (!code) return "idle";
  // CSRF: the returned state MUST carry the nonce this device generated at
  // connect() time (in either the web or native state format). A forged link
  // carrying an attacker's code won't match, so it's never exchanged into the
  // victim's account (silently ignored).
  if (!nonce || !returnedState || !expectedPolarStates(nonce).includes(returnedState)) return "idle";
  // A genuine return with a valid state: any non-connected result here is a real
  // failure the user should see (they authorized and expect a result).
  const res = await invoke<{ connected?: boolean }>({ action: "exchange", code, redirectUri: redirectUri() });
  return res?.connected ? "connected" : "failed";
}

export const polarProvider: ImportProvider = {
  id: "polar",
  label: "Polar",
  kind: "cloud",
  // Web + native: web uses the full-page redirect; native opens the system
  // browser and gets the return bounced to the polar-callback deep link (see
  // the module comment). Still dormant everywhere until VITE_POLAR_CLIENT_ID
  // is set — native builds get it from release.yml's web-build env.
  platform: "both",
  isAvailable: () => polarEnabled,
  isConnected: async () => {
    if (!polarEnabled) return false;
    const res = await invoke<{ connected?: boolean }>({ action: "status" });
    return !!res?.connected;
  },
  connect,
  disconnect: () => { void invoke({ action: "disconnect" }); },
  // Polar's transaction pull returns only new (un-consumed) exercises, so the
  // local run list / window aren't needed — the registry dedupes on extId.
  scan: async () => {
    if (!polarEnabled) return [];
    const res = await invoke<{ exercises?: PolarExercise[] }>({ action: "sync" });
    const exercises = res?.exercises || [];
    const out: ImportedRun[] = [];
    for (const ex of exercises) {
      if (!ex?.id) continue;
      const run = polarExerciseToRun(ex);
      if (run) out.push(run);
    }
    return out;
  },
  help:
    "Connect your Polar account to import finished runs (route, pace, elevation and " +
    "heart-rate) recorded on your Polar watch, even when you leave your phone at home.",
};
