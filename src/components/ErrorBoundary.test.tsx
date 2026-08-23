import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";

// A crash trace that can't name the build it came from is untriageable: the iOS
// 15 lookbehind crash was reported from a binary predating the fix and read as a
// regression, because nothing in the trace said which version it was.
const native = vi.hoisted(() => ({ isNative: true, label: "1.4.2 (57)" }));

vi.mock("../native", () => ({
  get isNative() { return native.isNative; },
  nativeBuildLabel: () => native.label,
}));
vi.mock("../telemetry", () => ({
  getCrashConsent: () => true,
  captureError: vi.fn(),
}));

const { ErrorBoundary } = await import("./ErrorBoundary");

function Throw(): ReactNode {
  throw new Error("boom");
}

const traceOf = () => {
  render(<ErrorBoundary><Throw /></ErrorBoundary>);
  fireEvent.click(screen.getAllByRole("button")[0]);
  return document.querySelector("pre")?.textContent ?? "";
};

describe("ErrorBoundary crash trace", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("names the installed build on native", () => {
    native.isNative = true;
    expect(traceOf()).toContain("App: 1.4.2 (57)");
  });

  it("says unknown rather than omitting the line if getInfo hasn't resolved", () => {
    native.isNative = true;
    native.label = "";
    expect(traceOf()).toContain("App: unknown");
    native.label = "1.4.2 (57)";
  });

  it("omits the line on web, where the store version means nothing", () => {
    native.isNative = false;
    const trace = traceOf();
    expect(trace).not.toContain("App:");
    expect(trace).toContain("Running Coach crash report");
    native.isNative = true;
  });
});
