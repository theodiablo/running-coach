// Week windows, server side. Date-string twin of the helpers in
// src/utils/plan.ts (Deno can't import from src) — keep both ends in sync, the
// same deal as runDigest.mjs. A plan week owns [startDate, startDate + 7), so a
// week is elapsed once that span has ended.
//
// A rebuild keeps the elapsed weeks in the plan (carryProgress), which makes
// "already lived" a real distinction here: history is the training record, not
// something the coach can still change, so the load rules and the model's plan
// context are computed over the live weeks only.

const dayMs = 86400000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const todayYmd = () => new Date().toISOString().slice(0, 10);

export const addDays = (ymd, n) =>
  new Date(new Date(ymd + "T00:00:00Z").getTime() + n * dayMs).toISOString().slice(0, 10);

// A malformed startDate reads as NOT elapsed on purpose: the structural
// MALFORMED check owns that week, and silently dropping it out of the load
// rules would hide it from them instead.
export const isElapsedWeek = (w, today = todayYmd()) =>
  YMD.test((w && w.startDate) || "") && addDays(w.startDate, 7) <= today;

export const liveWeeks = (plan, today) =>
  ((plan && plan.weeks) || []).filter(w => !isElapsedWeek(w, today));

export const elapsedWeeks = (plan, today) =>
  ((plan && plan.weeks) || []).filter(w => isElapsedWeek(w, today));
