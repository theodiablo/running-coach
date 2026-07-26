// The seam between App.tsx, which processes auth callbacks (deep link on
// native, URL params on web), and RunningCoach, which owns the only toast.
//
// It is a buffered event, not a bare one, because a callback can be processed
// before anything is listening: a deep link that COLD-STARTS the app is handled
// from getLaunchUrl while the store is still loading and RunningCoach has yet to
// mount. A plain dispatch would be swallowed there, which is precisely the
// "I tapped the link and the app said nothing" failure this exists to fix. So
// the notice is parked, then drained by whoever gets there first: a live
// listener drains it synchronously inside emitAuthNotice, and a late-mounting
// host drains it on mount.
export const AUTH_NOTICE_EVENT = "rc-auth-notice";

export type AuthNotice = { key: string; type: "ok" | "err"; vars?: Record<string, string> };

let pending: AuthNotice | null = null;

export function emitAuthNotice(key: string, type: "ok" | "err" = "ok", vars?: Record<string, string>) {
  pending = { key, type, vars };
  window.dispatchEvent(new Event(AUTH_NOTICE_EVENT));
}

// Consumes the parked notice, if any. One consumption path for both timings, so
// a notice can never be shown twice.
export function takeAuthNotice(): AuthNotice | null {
  const notice = pending;
  pending = null;
  return notice;
}
