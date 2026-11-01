// Carries auth-callback feedback from App.tsx to RunningCoach, which owns the only toast.
// BUFFERED: a cold-start deep link is handled before RunningCoach mounts, so the notice is
// parked and drained by whichever comes first, a live listener in emitAuthNotice or a late mount.
export const AUTH_NOTICE_EVENT = "rc-auth-notice";

export type AuthNotice = { key: string; type: "ok" | "err"; vars?: Record<string, string> };

let pending: AuthNotice | null = null;

export function emitAuthNotice(key: string, type: "ok" | "err" = "ok", vars?: Record<string, string>) {
  parkAuthNotice(key, type, vars);
  window.dispatchEvent(new Event(AUTH_NOTICE_EVENT));
}

// Park WITHOUT dispatching, for a host about to be remounted: a live dispatch
// would be drained by the outgoing instance, whose toast dies with it.
export function parkAuthNotice(key: string, type: "ok" | "err" = "ok", vars?: Record<string, string>) {
  pending = { key, type, vars };
}

// One consumption path for both timings, so a notice can't be shown twice.
export function takeAuthNotice(): AuthNotice | null {
  const notice = pending;
  pending = null;
  return notice;
}
