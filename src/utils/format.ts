// Formatting / date helpers shared across views.
// Dates follow the active UI locale; the "min"/"h" tokens in mins/estMin stay
// as-is — they're the standard abbreviations in English, Spanish and French.

import { currentLocaleTag } from "../i18n";

export const p2 = (n: string | number) => String(n).padStart(2, "0");

export const fmt = {
  pace: (s: string | number | null | undefined) => {
    const sec = Number(s);
    return (!sec || sec <= 0) ? "--:--" : Math.floor(sec/60) + ":" + p2(Math.round(sec%60));
  },
  dur: (s: number | null | undefined) => {
    if (!s) return "--";
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sc = Math.round(s%60);
    return h ? (h + ":" + p2(m) + ":" + p2(sc)) : (m + ":" + p2(sc));
  },
  date: (s: string) => s ? new Date(s+"T12:00:00").toLocaleDateString(currentLocaleTag(),{day:"numeric",month:"short",year:"numeric"}) : "",
  sht:  (s: string) => s ? new Date(s+"T12:00:00").toLocaleDateString(currentLocaleTag(),{day:"numeric",month:"short"}) : "",
  // A whole-minute duration as a compact label: 30min, 1h, 1h15, 1h50. Avoids
  // the raw-float "1.8333333333333335h" you get from a bare `minutes / 60`.
  mins: (m: number | string | null | undefined) => {
    if (m == null || m === "") return "";
    const minutes = Number(m);
    if (minutes < 60) return minutes + "min";
    const h = Math.floor(minutes / 60), r = Math.round(minutes % 60);
    return r ? h + "h" + p2(r) : h + "h";
  },
};

// Parse a colon-separated time string into seconds — accepts a goal time
// ("m:ss" / "h:mm:ss") or a pace ("m:ss" per km). Each segment carries over at
// 60, so it round-trips with fmt.dur / fmt.pace. Returns null for blank or
// non-numeric input so callers can ignore an incomplete edit rather than
// snapping the value to 0.
export const parseDur = (str: string | null | undefined): number | null => {
  const t = (str ?? "").trim();
  if (!t) return null;
  const parts = t.split(":");
  if (parts.some((p) => p.trim() === "" || isNaN(Number(p)))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
};

// Local YYYY-MM-DD. Using toISOString() here would convert to UTC and shift the
// calendar day for anyone east of GMT (e.g. a Monday at local midnight becomes
// the Sunday before), so we read the date parts in local time instead.
export const ymd = (d: Date) => d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());

// Monday (local) of the week containing `d` — the app buckets weeks Mon-Sun.
export const weekStart = (d: Date) => {
  const mon = new Date(d);
  mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return mon;
};

// Same, keyed off a YYYY-MM-DD run date and returned as one — the bucket key
// for weekly charts and active-week counts.
export const weekKey = (dateStr: string) => ymd(weekStart(new Date(dateStr + "T00:00:00")));

// A YYYY-MM-DD date `n` weeks from `from` (default today, local). Used to
// synthesize a target date for the no-race "get fit" onboarding branch so
// buildPlan has a timeline to size the plan against.
export const addWeeks = (n: number, from = new Date()) => {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  d.setDate(d.getDate() + n * 7);
  return ymd(d);
};

// Estimated session duration (rounded minutes) for the prescribed distance/pace.
export const estMin = (km: number, pace: number) => (km && pace) ? Math.round(km * pace / 60) + " min" : "";

// Strip any stale "· N min" slot label baked into older stored descriptions —
// the real estimate is shown alongside km/pace instead.
export const cleanDesc = (d: string | null | undefined) => (d || "").replace(/\s*·\s*~?\d+\s*min\s*$/, "");
