// The runners this browser follows on the public watch page. Per browser, never
// per account: the page has no session, and the list must not follow a sign-in
// or be cleared by a sign-out (unlike LIVE_SHARE_LINK_KEY, which is account
// data). Written ONLY on an explicit Follow, which is what keeps the page within
// ePrivacy art. 5(3)'s strictly-necessary exemption (docs/live-sharing.md).
//
// It holds standing links to people's live location, so it keeps the minimum:
// token, the viewer's own label, a colour, when it was added. Never a position,
// a finish time or a "last seen live" — that would build a history of when a
// third party runs, which the link itself never shows.

import { isValidShareToken } from "./shareLink";

export const FOLLOW_KEY = "rc_watch_follows";
const VERSION = 1;
export const FOLLOW_MAX = 10;
// From when it was added, so a link sent weeks before a race survives to race day.
export const FOLLOW_TTL_MS = 60 * 86400000;
export const FOLLOW_NAME_MAX = 24;

// Clear of the map's existing meanings: orange (brand/own route), red (live dot),
// amber (quiet/paused), sky (route guides), green (start), blue (own location).
export const FOLLOW_COLORS = [
  "#a78bfa", "#f472b6", "#2dd4bf", "#e2e8f0", "#a3e635",
  "#e879f9", "#818cf8", "#fde047", "#5eead4", "#fda4af",
];

export type FollowedRunner = { token: string; name: string; color: string; addedAt: number };

function parse(raw: string | null, now: number): FollowedRunner[] {
  if (!raw) return [];
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  const list = (data as { v?: unknown; runners?: unknown })?.v === VERSION
    ? (data as { runners?: unknown }).runners : null;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: FollowedRunner[] = [];
  for (const r of list as Partial<FollowedRunner>[]) {
    if (!r || !isValidShareToken(r.token) || seen.has(r.token as string)) continue;
    const addedAt = Number(r.addedAt);
    if (!Number.isFinite(addedAt) || now - addedAt > FOLLOW_TTL_MS) continue;
    seen.add(r.token as string);
    out.push({
      token: r.token as string,
      name: typeof r.name === "string" ? r.name.slice(0, FOLLOW_NAME_MAX) : "",
      color: typeof r.color === "string" && FOLLOW_COLORS.includes(r.color) ? r.color : FOLLOW_COLORS[0],
      addedAt,
    });
  }
  return out.slice(0, FOLLOW_MAX);
}

// Reads never write, so a visitor who never taps Follow never gets the key.
export function readFollows(now = Date.now()): FollowedRunner[] {
  try { return parse(localStorage.getItem(FOLLOW_KEY), now); } catch { return []; }
}

// Read-modify-write against the CURRENT stored list, so two open tabs merge
// rather than one silently dropping the other's runner.
function update(fn: (list: FollowedRunner[]) => FollowedRunner[], now = Date.now()): FollowedRunner[] {
  const next = fn(readFollows(now)).slice(0, FOLLOW_MAX);
  try {
    if (next.length) localStorage.setItem(FOLLOW_KEY, JSON.stringify({ v: VERSION, runners: next }));
    else localStorage.removeItem(FOLLOW_KEY);
  } catch { /* private mode / blocked storage: the page still works for this visit */ }
  return next;
}

const cleanName = (name: string) => name.trim().replace(/\s+/g, " ").slice(0, FOLLOW_NAME_MAX);

function nextColor(list: FollowedRunner[]): string {
  const used = new Set(list.map(r => r.color));
  return FOLLOW_COLORS.find(c => !used.has(c)) ?? FOLLOW_COLORS[list.length % FOLLOW_COLORS.length];
}

export type FollowOutcome = { ok: true; list: FollowedRunner[] } | { ok: false; reason: "full" | "invalid" };

// `replaces`: the old token of a runner who sent a new link (a replaced link
// looks exactly like a run that hasn't started, so only the viewer can say so).
// The runner keeps their colour and place in the list.
export function followRunner(token: string, name: string, replaces: string | null = null, now = Date.now()): FollowOutcome {
  if (!isValidShareToken(token)) return { ok: false, reason: "invalid" };
  const current = readFollows(now);
  const known = current.some(r => r.token === token);
  if (!known && !replaces && current.length >= FOLLOW_MAX) return { ok: false, reason: "full" };
  const list = update(list => {
    const label = cleanName(name);
    if (list.some(r => r.token === token)) return list.map(r => r.token === token ? { ...r, name: label } : r);
    const old = replaces ? list.find(r => r.token === replaces) : undefined;
    if (old) return list.map(r => r.token === replaces ? { token, name: label, color: old.color, addedAt: now } : r);
    if (list.length >= FOLLOW_MAX) return list;
    return [...list, { token, name: label, color: nextColor(list), addedAt: now }];
  }, now);
  return list.some(r => r.token === token) ? { ok: true, list } : { ok: false, reason: "full" };
}

export const unfollowRunner = (token: string): FollowedRunner[] => update(list => list.filter(r => r.token !== token));

export const forgetAllRunners = (): FollowedRunner[] => update(() => []);

// The runner a new link most likely replaces: same label, case-insensitive.
export function sameNameAs(list: FollowedRunner[], token: string, name: string): FollowedRunner | null {
  const label = cleanName(name).toLowerCase();
  if (!label) return null;
  return list.find(r => r.token !== token && r.name.toLowerCase() === label) ?? null;
}

// Other tabs' writes. The `storage` event never fires in the writing tab itself.
export function subscribeFollows(onChange: (list: FollowedRunner[]) => void): () => void {
  const onStorage = (e: StorageEvent) => { if (e.key === FOLLOW_KEY || e.key === null) onChange(readFollows()); };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
