import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

// Dictation lives in its own file so FeedbackSheet.test.tsx can keep exercising
// the REAL seam on the web (getSpeechSource returning null, no mic, no
// microphone prompt) — the guarantee the whole web build rests on. Here the
// seam is faked so the listening state machine can be driven end to end.
const speech = vi.hoisted(() => ({
  prepare: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
  handlers: null as null | {
    onPartial: (t: string) => void;
    onFinal: (t: string) => void;
    onEnd: (r: string, m?: string) => void;
  },
}));
vi.mock("../speech/source", () => ({
  getSpeechSource: () => ({
    prepare: speech.prepare,
    start: async (_lang: string, h: never) => { speech.handlers = h; return { stop: speech.stop }; },
  }),
}));
vi.mock("../betaFeedback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../betaFeedback")>()),
  submitBetaFeedback: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../telemetry", () => ({ track: vi.fn() }));
vi.mock("../native", () => ({ isNative: true, platform: "android", nativeBuildLabel: () => "1.0 (1)" }));

import { FeedbackSheet } from "./FeedbackSheet";

afterEach(cleanup);

const props = {
  source: "progress" as const,
  introSeen: true,
  onIntroSeen: vi.fn(),
  onSent: vi.fn(),
  onClose: vi.fn(),
  showToast: vi.fn(),
};

beforeEach(() => {
  speech.prepare.mockReset().mockResolvedValue(true);
  speech.stop.mockClear();
  speech.handlers = null;
  props.showToast.mockClear();
});

const startDictating = async () => {
  render(<FeedbackSheet {...props}/>);
  fireEvent.click(screen.getByRole("button", { name: "Record a note" }));
  await waitFor(() => expect(speech.handlers).not.toBeNull());
};

describe("FeedbackSheet dictation", () => {
  it("stops showing a live microphone once the recognizer settles", async () => {
    // Both plugins release the recognizer after a final result. Leaving the UI
    // in its listening state told the user their next sentence was being
    // captured when the microphone had already closed.
    await startDictating();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    speech.handlers!.onFinal("the pace chart is unreadable");
    speech.handlers!.onEnd("final");

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument());
    expect(screen.getByRole("textbox")).toHaveValue("the pace chart is unreadable");
  });

  it("renders interim words while they are still being guessed", async () => {
    await startDictating();
    speech.handlers!.onPartial("the pace chart is");
    await waitFor(() => expect(screen.getByText("the pace chart is")).toBeInTheDocument());
  });

  it("says so when dictation cannot start, instead of a dead button", async () => {
    // A denied permission, no on-device model for this locale, or a recognizer
    // already in use. Silence here reads as a broken app.
    speech.prepare.mockResolvedValue(false);
    render(<FeedbackSheet {...props}/>);
    fireEvent.click(screen.getByRole("button", { name: "Record a note" }));
    await waitFor(() =>
      expect(props.showToast).toHaveBeenCalledWith("Voice input isn't available. You can type instead."));
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it("reports a recognizer that dies mid-utterance", async () => {
    await startDictating();
    speech.handlers!.onEnd("error", "speech_error_7");
    await waitFor(() => expect(props.showToast).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it("closes the microphone when the sheet unmounts mid-utterance", async () => {
    await startDictating();
    cleanup();
    await waitFor(() => expect(speech.stop).toHaveBeenCalled());
  });
});
