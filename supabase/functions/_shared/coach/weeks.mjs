// Week windows. THE definition of an elapsed week for both halves (Deno can't import from
// src; src/utils/plan.ts wraps it): a week owns [startDate, startDate + 7) and is elapsed
// once that span has ended. A rebuild keeps elapsed weeks (carryProgress) as the training
// record, so load rules and the model's plan context use the live weeks only.

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
