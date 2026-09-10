import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const submitBetaFeedback = vi.fn().mockResolvedValue(undefined);
vi.mock("../betaFeedback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../betaFeedback")>()),
  submitBetaFeedback: (...args: unknown[]) => submitBetaFeedback(...args),
}));
vi.mock("../telemetry", () => ({ track: vi.fn() }));
vi.mock("../native", () => ({ isNative: false, platform: "web", nativeBuildLabel: () => "" }));

import { FeedbackSheet } from "./FeedbackSheet";

afterEach(cleanup);
beforeEach(() => submitBetaFeedback.mockClear());

const props = {
  source: "progress" as const,
  introSeen: true,
  onIntroSeen: vi.fn(),
  onSent: vi.fn(),
  onClose: vi.fn(),
  showToast: vi.fn(),
};

describe("FeedbackSheet", () => {
  it("shows the explainer only until it has been seen", () => {
    const onIntroSeen = vi.fn();
    const { rerender } = render(
      <FeedbackSheet {...props} introSeen={false} onIntroSeen={onIntroSeen}/>);
    expect(screen.getByText("Tell us what's not working")).toBeInTheDocument();

    // Leaving the explainer spends the flag there and then, so a sheet reopened
    // before the settings blob round-trips doesn't show it a second time.
    fireEvent.click(screen.getByRole("button", { name: "Type" }));
    expect(onIntroSeen).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Tell us what's not working")).not.toBeInTheDocument();

    rerender(<FeedbackSheet {...props} introSeen onIntroSeen={onIntroSeen}/>);
    expect(screen.queryByText("Tell us what's not working")).not.toBeInTheDocument();
  });

  it("offers no microphone where there is no recognizer", () => {
    // The web build: the seam returns null, so the sheet must not advertise
    // dictation or promise that nothing is uploaded — there is no recording.
    render(<FeedbackSheet {...props} introSeen={false}/>);
    expect(screen.queryByText(/Record a note/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No recording is kept/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Type" })).toBeInTheDocument();
  });

  it("shows the context block it is about to send", () => {
    // Shown, not hidden in a payload: people say more when they can see exactly
    // what goes with it.
    render(<FeedbackSheet {...props}/>);
    expect(screen.getByText("Progress")).toBeInTheDocument();
    expect(screen.getByText("Sent with your note")).toBeInTheDocument();
  });

  it("refuses to send an empty report and sends the edited text", async () => {
    render(<FeedbackSheet {...props}/>);
    const send = screen.getByRole("button", { name: "Send feedback" });
    expect(send).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  charts unreadable  " } });
    expect(send).not.toBeDisabled();
    fireEvent.click(send);

    await waitFor(() => expect(submitBetaFeedback).toHaveBeenCalledWith({
      body: "charts unreadable", source: "progress", inputMode: "text",
    }));
  });
});
