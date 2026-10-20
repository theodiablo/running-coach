import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { HelpPage } from "./HelpPage";
import type { SettingsState } from "../../types";

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

  it("includes stretching, with no testing notice", () => {
    render(<HelpPage/>);
    fireEvent.click(screen.getByRole("button", { name: /^Stretching/ }));
    expect(screen.getByText("Will stretching stop me getting injured?")).toBeInTheDocument();
    expect(screen.getByText("How the app decides")).toBeInTheDocument();
    expect(screen.queryByText(/isn't available to the public yet/)).toBeNull();
  });

  it("explains heart-rate zones on the runner's own numbers", () => {
    render(<HelpPage settings={{ maxHR: 188, restHR: 50 } as SettingsState}/>);
    fireEvent.click(screen.getByRole("button", { name: "Heart-rate zones" }));
    expect(screen.getByText(/top of Zone 2 is 50 \+ 70% × 138 = 147 bpm/)).toBeInTheDocument();
  });
});
