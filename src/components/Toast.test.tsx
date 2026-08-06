import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Toast } from "./Toast";

// Toast is presentational: the badge variant shows a medal, and `closing` swaps
// the enter animation for the exit one.

describe("Toast", () => {
  it("renders the badge variant with a medal icon", () => {
    const { container, getByText } = render(<Toast msg="New badge!" type="badge" />);
    expect(getByText("New badge!")).toBeInTheDocument();
    // lucide renders an <svg> for the Medal icon.
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("uses the enter animation normally and the exit animation when closing", () => {
    const { container, rerender } = render(<Toast msg="hi" type="ok" />);
    const banner = container.firstElementChild as HTMLElement;
    expect(banner).toHaveClass("animate-toast-in");
    rerender(<Toast msg="hi" type="ok" closing />);
    expect(banner).toHaveClass("animate-toast-out");
  });
});
