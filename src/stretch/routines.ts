// The stretching content, as data: the moves and the routines built from them.
// Copy lives in the `stretch` locale files keyed by these ids. The research
// behind the choices (and what the copy must never claim): docs/stretching.md.

import type { TFunction } from "i18next";
import type { PoseId } from "./poses";

export type MoveId = PoseId;

/** "hold" counts down a static stretch; "drill" times a moving one. */
export const MOVE_KIND: Record<MoveId, "hold" | "drill"> = {
  calfWall: "hold", calfBent: "hold", quad: "hold", hipFlexor: "hold",
  hamStrap: "hold", kneeChest: "hold", child: "hold", legsWall: "hold",
  legSwing: "drill", lunge: "drill", highKnees: "drill", calfRaise: "drill", catCow: "drill",
};

/** One move in a routine: seconds per side, both sides or one. */
export type RoutineItem = { move: MoveId; sec: number; sides: 1 | 2 };

export type RoutineId = "cooldown" | "recovery" | "warmup" | "restday";

export type Routine = {
  id: RoutineId;
  items: RoutineItem[];
  /** Times `items` is repeated before `tail`. */
  rounds?: number;
  tail?: RoutineItem[];
};

const item = (move: MoveId, sec: number, sides: 1 | 2 = 2): RoutineItem => ({ move, sec, sides });

const COOLDOWN_ITEMS: RoutineItem[] = [
  item("calfWall", 30), item("calfBent", 30), item("quad", 30),
  item("hipFlexor", 30), item("hamStrap", 30), item("kneeChest", 30),
];

export const ROUTINES: Record<RoutineId, Routine> = {
  cooldown: { id: "cooldown", items: COOLDOWN_ITEMS },
  recovery: {
    id: "recovery",
    items: [
      item("catCow", 60, 1), item("child", 60, 1), item("hipFlexor", 45),
      item("kneeChest", 45), item("calfWall", 30), item("legsWall", 120, 1),
    ],
  },
  warmup: {
    id: "warmup",
    items: [item("legSwing", 30), item("lunge", 40, 1), item("highKnees", 20, 1), item("calfRaise", 30, 1)],
  },
  restday: { id: "restday", items: COOLDOWN_ITEMS, rounds: 2, tail: [item("child", 60, 1)] },
};

export const ROUTINE_ORDER: RoutineId[] = ["cooldown", "recovery", "warmup", "restday"];

/** Why a cool-down was tuned: the run it follows decides what gets more time. */
export type CooldownFocus = "standard" | "hills" | "hard";

const LONG_HOLD = 45;

/** The cool-down reshaped for the run it follows: calves first after hills, more hips and hamstrings after a hard session. */
export function cooldownFor(focus: CooldownFocus): Routine {
  if (focus === "hills") {
    const calves = COOLDOWN_ITEMS.filter(i => i.move === "calfWall" || i.move === "calfBent").map(i => ({ ...i, sec: LONG_HOLD }));
    return { id: "cooldown", items: [...calves, ...COOLDOWN_ITEMS.filter(i => !calves.some(c => c.move === i.move))] };
  }
  if (focus === "hard") {
    return { id: "cooldown", items: COOLDOWN_ITEMS.map(i => (i.move === "hipFlexor" || i.move === "hamStrap" ? { ...i, sec: LONG_HOLD } : i)) };
  }
  return ROUTINES.cooldown;
}

/** How long a routine item lasts, as the routine and the preview both write it. */
export function itemTime(t: TFunction, item: RoutineItem): string {
  if (item.sides === 2) return t("stretch.sheet.eachSide", { sec: item.sec });
  return item.sec >= 120 ? t("stretch.sheet.wholeMinutes", { min: item.sec / 60 }) : t("stretch.sheet.seconds", { sec: item.sec });
}
