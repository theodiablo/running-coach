// Render a plan session's display sentence from its structured descriptor
// (`sd`) in the active UI language. buildPlan (and the coach) still emit the
// English `desc` as the canonical, model-readable fallback; this is the
// localized view layer over the same data. Anything without a mappable `sd`
// (legacy stored plans, coach-authored sessions not yet carrying `sd`) falls
// back to the stored English `desc` via describeSession.

import i18n, { t } from "../i18n";
import { fmt, cleanDesc } from "./format";
import { runwalkRatio } from "./sessionSteps";
import type { PlanSession, SessionSd } from "../types";

// Rep-distance label: 1000/3000 m → "1km"/"3km", otherwise "800m". Language-
// neutral (digits + km/m), so it is composed here rather than translated.
const repDist = (m: number | undefined): string =>
  m == null ? "" : m % 1000 === 0 ? m / 1000 + "km" : m + "m";

const has = (key: string): boolean => i18n.exists(key);

// Returns the localized sentence, or null when `sd` maps to no known template
// (so the caller can fall back to the stored English `desc`).
export function renderSd(
  sd: SessionSd | undefined,
  s: { pace?: number | null } = {},
): string | null {
  if (!sd) return null;
  const pace = fmt.pace(s.pace);
  switch (sd.kind) {
    case "long":
    case "easy":
    case "tempo": {
      const key = `plan.${sd.kind}.${sd.variant}`;
      return has(key) ? t(key, { pace }) : null;
    }
    case "intervals": {
      const v = sd.variant;
      // Coach-authored generic intervals carry no reps/rep-distance.
      if (v === "coachGeneric" || v === "coachGenericNoPace") return t(`plan.intervals.${v}`, { pace });
      if (v !== "standard" && v !== "speed" && v !== "strength") return null;
      const dist = repDist(sd.repM);
      if (v === "strength")
        return t("plan.intervals.strength", { reps: sd.reps, dist, offset: sd.offsetSec, pace });
      const recovery = sd.recover && has(`plan.rec.${sd.recover}`) ? t(`plan.rec.${sd.recover}`) : "";
      return t(`plan.intervals.${v}`, { reps: sd.reps, dist, pace, recovery });
    }
    case "runwalk": {
      const key = `plan.runwalk.${sd.variant}`;
      if (!has(key)) return null;
      const r = runwalkRatio({ sd }, "");
      return t(key, r ? { run: fmt.interval(r.runSec), walk: fmt.interval(r.walkSec) } : {});
    }
    case "cross":
      return t("plan.cross", { mins: fmt.mins(sd.minutes) });
    // Coach-authored kinds: a converted no-impact walk and a recovery-week run.
    case "crosswalk":
      return t("plan.crosswalk");
    case "crossActivity": {
      const key = `plan.crossActivityName.${sd.activity}`;
      return has(key) ? t("plan.crossActivity", { mins: fmt.mins(sd.minutes), activity: t(key) }) : null;
    }
    case "recovery":
      return t("plan.recovery");
    case "race": {
      const elev = sd.elevM ? t("plan.raceElev", { elevM: sd.elevM }) : "";
      return t("plan.race", { km: sd.km, elev });
    }
    case "raceday": {
      const elev = sd.elevM ? t("plan.racedayElev", { elevM: sd.elevM }) : "";
      return t("plan.raceday", { km: sd.km, elev });
    }
    default:
      // recovery / crosswalk (coach-authored kinds) have no template yet —
      // fall back to the stored English desc.
      return null;
  }
}

// The one entry point for views: localized sentence if we can render `sd`,
// otherwise the stored English `desc` (legacy plans, coach sessions).
export function describeSession(s: PlanSession): string {
  const r = renderSd(s.sd, s);
  return r != null ? r : cleanDesc(s.desc);
}
