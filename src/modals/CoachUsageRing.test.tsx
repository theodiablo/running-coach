import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CoachUsageRing } from "./CoachUsageRing";

afterEach(cleanup);

describe("CoachUsageRing", () => {
  it("is subtle (ring only, no warning label) with plenty of budget left", () => {
    render(<CoachUsageRing usage={{ used: 1, limit: 5 }} />);
    // Ring button always present with an accessible name…
    expect(screen.getByRole("button", { name: /1 of 5/i })).toBeInTheDocument();
    // …but no "left today" / "resets" label while comfortable.
    expect(screen.queryByText(/left today/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/resets tomorrow/i)).not.toBeInTheDocument();
  });

  it("shows a remaining-count label as the budget runs low", () => {
    render(<CoachUsageRing usage={{ used: 3, limit: 5 }} />);
    expect(screen.getByText(/2 left today/i)).toBeInTheDocument();
  });

  it("shows a resets label when exhausted", () => {
    render(<CoachUsageRing usage={{ used: 5, limit: 5 }} />);
    expect(screen.getByText(/resets tomorrow/i)).toBeInTheDocument();
  });

  it("opens a usage breakdown popover on tap", () => {
    render(<CoachUsageRing usage={{ used: 3, limit: 5 }} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /3 of 5/i }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/3 of 5 used/i)).toBeInTheDocument();
    expect(screen.getByText(/don't count/i)).toBeInTheDocument();
  });
});
