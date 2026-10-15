// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { DEFAULT_AUDIO } from "../utils/callout";
import { compileSpec, DEFAULT_SPEC } from "../utils/workoutSpec";

// Android: JS never speaks, it seeds the native engine. Calls are logged in order.
const log = vi.hoisted(() => [] as string[]);
vi.mock("../cues", () => ({ playCue: vi.fn(), scheduleCue: vi.fn(), cancelScheduledCue: vi.fn(), releaseCues: vi.fn() }));
vi.mock("../native", () => ({ isAndroid: true, isIos: false, isNative: true }));
vi.mock("../geo/workoutGuide", () => ({
  seedWorkoutGuide: (cfg: { idx: number }) => { log.push("seed:" + cfg.idx); },
  clearWorkoutGuide: () => { log.push("clear"); },
}));

import { useGuidedWorkout } from "./useGuidedWorkout";

type State = "idle" | "tracking" | "paused" | "stopped";
const tempo = compileSpec({ ...DEFAULT_SPEC, type: "tempo", warmMin: 1, coolMin: 0, blockKm: 5, pace: 300 }, { band: 10 });

describe("useGuidedWorkout on Android", () => {
  it("clears the native engine before this mount's first seed (a page reload keeps the plugin alive)", () => {
    const { rerender } = renderHook(
      ({ state, km, movingSec }: { state: State; km: number; movingSec: number }) =>
        useGuidedWorkout({ workout: tempo, audioOn: true, prefs: DEFAULT_AUDIO, state, stats: { km, movingSec, curPace: 300 }, kind: "tempo" }),
      { initialProps: { state: "idle" as State, km: 0, movingSec: 0 } });
    rerender({ state: "tracking", km: 0, movingSec: 0 });
    rerender({ state: "tracking", km: 0.2, movingSec: 61 });
    expect(log).toEqual(["clear", "seed:0", "seed:1"]);
  });
});
