import { describe, it, expect, vi, beforeEach } from "vitest";

// One microphone, one session. These pin the three ways a session can end
// without the caller asking, each of which previously left a consumer showing
// a live mic over a recognizer that had already released it.
const listeners: Record<string, (d: { text?: string; message?: string }) => void> = {};
const plugin = {
  available: vi.fn().mockResolvedValue({ available: true }),
  requestPermission: vi.fn().mockResolvedValue({ granted: true }),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  addListener: vi.fn(async (event: string, cb: (d: never) => void) => {
    listeners[event] = cb as (d: { text?: string; message?: string }) => void;
    return { remove: vi.fn().mockResolvedValue(undefined) };
  }),
};
vi.mock("./plugin", () => ({ getSpeechPlugin: () => plugin }));

const { nativeSpeechSource } = await import("./native");

const handlers = () => ({ onPartial: vi.fn(), onFinal: vi.fn(), onEnd: vi.fn() });

describe("nativeSpeechSource", () => {
  beforeEach(() => {
    plugin.available.mockClear().mockResolvedValue({ available: true });
    plugin.requestPermission.mockClear().mockResolvedValue({ granted: true });
    plugin.start.mockClear();
    plugin.stop.mockClear();
  });

  it("asks for permission before availability", async () => {
    // iOS reports a recognizer unavailable while authorization is still
    // notDetermined, so checking first would hide the mic on every fresh
    // install and the usage-description strings would never be exercised.
    await nativeSpeechSource.prepare("en-GB");
    expect(plugin.requestPermission.mock.invocationCallOrder[0])
      .toBeLessThan(plugin.available.mock.invocationCallOrder[0]);
  });

  it("does not ask about availability when permission is refused", async () => {
    plugin.requestPermission.mockResolvedValue({ granted: false });
    expect(await nativeSpeechSource.prepare("en-GB")).toBe(false);
    expect(plugin.available).not.toHaveBeenCalled();
  });

  it("ends the session when the recognizer settles an utterance", async () => {
    // Both plugins release the recognizer after a final result, so the session
    // is over even though nobody asked it to stop.
    const h = handlers();
    await nativeSpeechSource.start("en-GB", h);
    listeners.final({ text: "calves were tight" });
    expect(h.onFinal).toHaveBeenCalledWith("calves were tight");
    expect(h.onEnd).toHaveBeenCalledWith("final", undefined);
  });

  it("tells the first surface when a second one takes the microphone", async () => {
    // The feedback sheet opens OVER the coach chat, so both hold a dictation
    // hook at once. Without this the coach would sit on a frozen partial and
    // its Stop button would stop the sheet's session instead.
    const first = handlers();
    await nativeSpeechSource.start("en-GB", first);
    const second = handlers();
    await nativeSpeechSource.start("en-GB", second);
    expect(first.onEnd).toHaveBeenCalledWith("superseded", undefined);
    expect(second.onEnd).not.toHaveBeenCalled();

    // Events now belong to the second session only.
    listeners.partial({ text: "later words" });
    expect(first.onPartial).not.toHaveBeenCalled();
    expect(second.onPartial).toHaveBeenCalledWith("later words");
  });

  it("reports an error once and stops delivering to that session", async () => {
    const h = handlers();
    await nativeSpeechSource.start("en-GB", h);
    listeners.error({ message: "speech_error_7" });
    listeners.final({ text: "ignored" });
    expect(h.onEnd).toHaveBeenCalledTimes(1);
    expect(h.onEnd).toHaveBeenCalledWith("error", "speech_error_7");
    expect(h.onFinal).not.toHaveBeenCalled();
  });

  it("stopping an already-ended session is a no-op", async () => {
    const h = handlers();
    const session = await nativeSpeechSource.start("en-GB", h);
    listeners.final({ text: "done" });
    await session!.stop();
    expect(h.onEnd).toHaveBeenCalledTimes(1);
    expect(plugin.stop).not.toHaveBeenCalled();
  });

  it("returns null and reports the problem when the recognizer will not start", async () => {
    plugin.start.mockRejectedValueOnce(new Error("recognizer unavailable"));
    const h = handlers();
    expect(await nativeSpeechSource.start("en-GB", h)).toBeNull();
    expect(h.onEnd).toHaveBeenCalledWith("error", "recognizer unavailable");
  });
});
