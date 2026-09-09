import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The guarantee the whole web build rests on: no speech source off native, so
// no mic button renders and nothing asks a browser for a microphone. Voice is
// deliberately native-only — Chrome's webkitSpeechRecognition streams audio to
// Google rather than transcribing locally, and Firefox has none at all.
const loadSeam = async (native: boolean) => {
  vi.resetModules();
  vi.doMock("../native", () => ({ isNative: native, platform: native ? "android" : "web" }));
  return (await import("./source")).getSpeechSource();
};

describe("getSpeechSource", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.doUnmock("../native"));

  it("returns null on the web build", async () => {
    expect(await loadSeam(false)).toBeNull();
  });

  it("returns a source inside the native shell", async () => {
    const source = await loadSeam(true);
    expect(source).not.toBeNull();
    expect(typeof source!.prepare).toBe("function");
    expect(typeof source!.start).toBe("function");
    expect(typeof source!.stop).toBe("function");
  });
});
