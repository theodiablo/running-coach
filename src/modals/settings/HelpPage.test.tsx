import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { HelpPage } from "./HelpPage";

afterEach(cleanup);

describe("HelpPage", () => {
  it("gathers the plan and prediction explainers, collapsed until opened", () => {
    render(<HelpPage/>);
    const plan = screen.getByRole("button", { name: "Your training plan" });
    expect(plan).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Race predictions" })).toBeInTheDocument();
    fireEvent.click(plan);
    expect(plan).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("1 · From goal to target pace")).toBeInTheDocument();
  });

  it("adds stretching for premium accounts only", () => {
    render(<HelpPage/>);
    expect(screen.queryByRole("button", { name: "Stretching" })).toBeNull();
    cleanup();
    render(<HelpPage isPremium/>);
    fireEvent.click(screen.getByRole("button", { name: "Stretching" }));
    expect(screen.getByText("Will stretching stop me getting injured?")).toBeInTheDocument();
    expect(screen.getByText("How the app decides")).toBeInTheDocument();
  });
});
