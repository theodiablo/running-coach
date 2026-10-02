// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { DEFAULT_AUDIO, type AudioPrefs } from "../utils/callout";
import { compileSpec, DEFAULT_SPEC } from "../utils/workoutSpec";

// The guidance hook over a fake tracker: stats are fed by hand, the cue seam
// is a spy, and the platform is web (JS owns the audio).
const cues = vi.hoisted(() => ({
  playCue: vi.fn(), scheduleCue: vi.fn(), cancelScheduledCue: vi.fn(), releaseCues: vi.fn(),
}));
vi.mock("../cues", () => cues);
vi.mock("../native", () => ({ isAndroid: false, isIos: false, isNative: false }));

import { useGuidedWorkout } from "./useGuidedWorkout";

type State = "idle" | "tracking" | "paused" | "stopped";
type Stats = { km: number; movingSec: number; curPace: number; hr?: number | null; hrAt?: number | null };

const tempo = compileSpec({ ...DEFAULT_SPEC, type: "tempo", warmMin: 0, coolMin: 0, blockKm: 5, pace: 300 },
  { band: 10, hr: { lo: 150, hi: 170 } });

function setup(prefs: AudioPrefs = DEFAULT_AUDIO, audioOn = true) {
  return renderHook(
    ({ state, stats }: { state: State; stats: Stats }) =>
      useGuidedWorkout({ workout: tempo, audioOn, prefs, state, stats, kind: "tempo" }),
    { initialProps: { state: "idle" as State, stats: { km: 0, movingSec: 0, curPace: 0 } as Stats } });
}

const spoken = (tone: string) => cues.playCue.mock.calls.filter(c => c[0] === tone).map(c => c[1] as string);

describe("useGuidedWorkout callouts", () => {
  beforeEach(() => { Object.values(cues).forEach(f => f.mockClear()); });

  it("announces the step, then a status callout every `freq` seconds of moving time", () => {
    const { rerender } = setup();
    rerender({ state: "tracking", stats: { km: 0, movingSec: 0, curPace: 0 } });
    expect(spoken("step")).toEqual(["Tempo block: 5 kilometres at 5 00 per kilometre."]);

    rerender({ state: "tracking", stats: { km: 0.15, movingSec: 45, curPace: 302 } });
    expect(spoken("info")).toEqual([]);
    rerender({ state: "tracking", stats: { km: 0.2, movingSec: 60, curPace: 302, hr: 160, hrAt: Date.now() } });
    expect(spoken("info")).toEqual(["On pace, 5 02. Heart rate 160. 4.8 kilometres left."]);
    rerender({ state: "tracking", stats: { km: 0.35, movingSec: 100, curPace: 330, hr: 160, hrAt: Date.now() } });
    expect(spoken("info")).toHaveLength(1);
    rerender({ state: "tracking", stats: { km: 0.4, movingSec: 120, curPace: 330, hr: 160, hrAt: Date.now() } });
    expect(spoken("info")[1]).toBe("A bit slow, 5 30. Push to 5 00. Heart rate 160. 4.6 kilometres left.");
  });

  it("warns at once when heart rate passes the zone top", () => {
    const { rerender } = setup();
    rerender({ state: "tracking", stats: { km: 0, movingSec: 0, curPace: 0 } });
    rerender({ state: "tracking", stats: { km: 0.1, movingSec: 30, curPace: 300, hr: 175, hrAt: Date.now() } });
    expect(spoken("fast")).toEqual(["Heart rate 175, above your zone. Ease off."]);
    rerender({ state: "tracking", stats: { km: 0.12, movingSec: 40, curPace: 300, hr: 176, hrAt: Date.now() } });
    expect(spoken("fast")).toHaveLength(1);
  });

  it("speaks nothing with audio off, yet still guides on screen", () => {
    const { result, rerender } = setup(DEFAULT_AUDIO, false);
    rerender({ state: "tracking", stats: { km: 0, movingSec: 0, curPace: 0 } });
    rerender({ state: "tracking", stats: { km: 1, movingSec: 300, curPace: 330, hr: 190, hrAt: Date.now() } });
    expect(cues.playCue).not.toHaveBeenCalled();
    expect(result.current.display?.verdict).toBe("slow");
    expect(result.current.display?.hrHigh).toBe(true);
  });

  it("per-km callouts fire on each kilometre and say the distance", () => {
    const { rerender } = setup({ ...DEFAULT_AUDIO, freq: "km", say: { pace: false, hr: false, dist: false, left: false } });
    rerender({ state: "tracking", stats: { km: 0, movingSec: 0, curPace: 0 } });
    rerender({ state: "tracking", stats: { km: 0.99, movingSec: 290, curPace: 300 } });
    expect(spoken("info")).toEqual([]);
    rerender({ state: "tracking", stats: { km: 1.01, movingSec: 300, curPace: 300 } });
    expect(spoken("info")).toEqual(["1.0 kilometre."]);
  });

  it("per-km callouts count from where guidance started (a recovered run)", () => {
    const { rerender } = setup({ ...DEFAULT_AUDIO, freq: "km" });
    rerender({ state: "tracking", stats: { km: 3.4, movingSec: 1000, curPace: 300 } });
    rerender({ state: "tracking", stats: { km: 3.5, movingSec: 1030, curPace: 300 } });
    expect(spoken("info")).toEqual([]);
    rerender({ state: "tracking", stats: { km: 4.01, movingSec: 1180, curPace: 300 } });
    expect(spoken("info")).toHaveLength(1);
  });

  it("says sub-minute run/walk intervals in seconds", () => {
    const rw = compileSpec({ ...DEFAULT_SPEC, type: "runwalk", warmMin: 0, runSec: 90, walkSec: 30 }, { band: 10 });
    const { rerender } = renderHook(({ state }: { state: State }) =>
      useGuidedWorkout({ workout: rw, audioOn: true, prefs: DEFAULT_AUDIO, state, stats: { km: 0, movingSec: 0, curPace: 0 }, kind: "runwalk" }),
      { initialProps: { state: "idle" as State } });
    rerender({ state: "tracking" });
    expect(spoken("step")).toEqual(["Run 90 seconds."]);
  });

  it("builds a sample callout for the settings sheet", () => {
    const { result } = setup();
    expect(result.current.sample(DEFAULT_AUDIO)).toBe("On pace, 5 03. Heart rate 160. 2.5 kilometres left.");
  });
});
