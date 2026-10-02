// Display copy for a WorkoutSpec — the recorder card's title/subline and the
// sheet's "from your plan" line. i18n-bound but React-free.
import type { TFunction } from "i18next";
import { fmt } from "./format";
import { isOpenSpec, type WorkoutSpec } from "./workoutSpec";

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

export function workoutTitle(spec: WorkoutSpec, t: TFunction): string {
  const at = spec.pace ? " " + t("tracker.setup.atPace", { pace: fmt.pace(spec.pace) }) : "";
  switch (spec.type) {
    case "tempo":
      return t("tracker.setup.title.tempo", { block: spec.blockUnit === "km" ? `${spec.blockKm} km` : t("tracker.guided.mins", { mins: spec.blockMin }) }) + at;
    case "intervals":
      return `${spec.reps} × ${spec.repUnit === "m" ? `${spec.repM} m` : mmss(spec.repSec)}${at}`;
    case "runwalk":
      return t("tracker.setup.title.runwalk", { run: mmss(spec.runSec), walk: mmss(spec.walkSec) });
    default:
      if (isOpenSpec(spec)) return t("tracker.setup.title.open");
      return (spec.goal === "km" ? `${spec.goalKm} km` : spec.goal === "time" ? fmt.mins(spec.goalMin) : t("tracker.setup.title.anyDistance")) + at;
  }
}

export function workoutSub(spec: WorkoutSpec, hr: { lo: number; hi: number } | null, t: TFunction): string {
  if (isOpenSpec(spec)) return t("tracker.setup.openHint");
  const bits: string[] = [];
  if (spec.type !== "regular" && spec.warmMin > 0) bits.push(t("tracker.setup.sub.warm", { mins: spec.warmMin }));
  if (spec.type === "intervals") bits.push(t("tracker.setup.sub.rest", { rest: spec.recUnit === "m" ? `${spec.recM} m` : mmss(spec.recSec) }));
  if (spec.hrZone) bits.push(`Z${spec.hrZone[0]}${spec.hrZone[1] !== spec.hrZone[0] ? "-" + spec.hrZone[1] : ""}${hr ? ` ${hr.lo}-${hr.hi}` : ""}`);
  if (spec.type !== "regular" && spec.type !== "runwalk" && spec.coolMin > 0) bits.push(t("tracker.setup.sub.cool", { mins: spec.coolMin }));
  return bits.join(" · ") || t("tracker.setup.sub.noHr");
}

