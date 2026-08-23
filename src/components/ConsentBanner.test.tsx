import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const native = vi.hoisted(() => ({ isNative: true }));
vi.mock("../native", () => ({ get isNative() { return native.isNative; } }));

const setTelemetryConsent = vi.hoisted(() => vi.fn());
vi.mock("../telemetry", () => ({
  isTelemetryConfigured: () => true,
  getConsentDecision: () => "unset",
  setTelemetryConsent,
}));

const { ConsentBanner } = await import("./ConsentBanner");

afterEach(cleanup);
beforeEach(() => { native.isNative = true; vi.clearAllMocks(); });

const switches = () => screen.getAllByRole("switch");

// Opt-in means opt-in: neither switch may start on, and the primary action must
// be a complete answer either way — which is what lets the screen do without a
// separate "skip" (continuing untouched IS the refusal).
describe("native consent screen", () => {
  it("starts with both channels off", () => {
    render(<ConsentBanner />);
    expect(switches()).toHaveLength(2);
    switches().forEach(s => expect(s).toHaveAttribute("aria-checked", "false"));
  });

  it("records a refusal of both when continued untouched", () => {
    render(<ConsentBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(setTelemetryConsent).toHaveBeenCalledWith({ analytics: false, crashes: false });
  });

  // The whole point of splitting the two: "fix your bugs, but don't measure me".
  it("records crash reports alone when only that switch is on", () => {
    render(<ConsentBanner />);
    fireEvent.click(screen.getByRole("switch", { name: /crash reports/i }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(setTelemetryConsent).toHaveBeenCalledWith({ analytics: false, crashes: true });
  });

  it("reports the analytics half to the host so it can identify the user", () => {
    const onConsentChange = vi.fn();
    render(<ConsentBanner onConsentChange={onConsentChange} />);
    fireEvent.click(screen.getByRole("switch", { name: /product analytics/i }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onConsentChange).toHaveBeenCalledWith(true);
  });

  it("disappears for good once answered", () => {
    const { container } = render(<ConsentBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(container).toBeEmptyDOMElement();
  });
});

// The web keeps the compact bar over the marketing landing; Accept/Decline there
// answers both channels together.
describe("web consent bar", () => {
  beforeEach(() => { native.isNative = false; });

  it("offers Accept/Decline rather than switches", () => {
    render(<ConsentBanner />);
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
  });

  it("grants both channels on Accept and neither on Decline", () => {
    render(<ConsentBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(setTelemetryConsent).toHaveBeenCalledWith({ analytics: true, crashes: true });

    cleanup();
    render(<ConsentBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(setTelemetryConsent).toHaveBeenLastCalledWith({ analytics: false, crashes: false });
  });
});
