import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import MarketingGate from "./MarketingGate";
import { TIP_JAR_URL } from "../constants";

describe("MarketingGate", () => {
  it("renders the marketing landing without a login form until asked", () => {
    render(<MarketingGate />);
    expect(screen.getByText(/Train for your race/i)).toBeInTheDocument();
    // The login form (reused LoginScreen) is not mounted until the user opts in.
    expect(screen.queryByPlaceholderText(/you@example.com/i)).toBeNull();
  });

  it("opens the login modal when the visitor chooses to log in", () => {
    render(<MarketingGate />);
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));
    expect(screen.getByPlaceholderText(/you@example.com/i)).toBeInTheDocument();
  });

  it("links to the Play Store listing and the iOS beta", () => {
    render(<MarketingGate />);

    expect(screen.getAllByRole("link", { name: /iOS beta|TestFlight/i })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: /iOS beta|TestFlight/i })[0]).toHaveAttribute(
      "href",
      "https://testflight.apple.com/join/T73yu15A",
    );
    const androidLinks = screen.getAllByRole("link", { name: /Google Play/i });
    expect(androidLinks).toHaveLength(2);
    expect(androidLinks[0]).toHaveAttribute(
      "href",
      "https://play.google.com/store/apps/details?id=solutions.camboulive.run",
    );
  });

  it("shows the tip-jar link in the footer", () => {
    render(<MarketingGate />);
    const support = screen.getByRole("link", { name: /buy me a coffee/i });
    expect(support).toHaveAttribute("href", TIP_JAR_URL);
    expect(support).toHaveAttribute("target", "_blank");
  });

  it("hides the tip-jar link when TIP_JAR_URL is empty", async () => {
    vi.resetModules();
    vi.doMock("../constants", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../constants")>()),
      TIP_JAR_URL: "",
    }));
    const { default: GateWithoutTipJar } = await import("./MarketingGate");
    render(<GateWithoutTipJar />);
    expect(screen.queryByRole("link", { name: /buy me a coffee/i })).toBeNull();
    vi.doUnmock("../constants");
    vi.resetModules();
  });
});
