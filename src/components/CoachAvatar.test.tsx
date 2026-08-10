import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CoachAvatar } from "./CoachAvatar";

afterEach(cleanup);

const svgOf = (ui: React.ReactElement) => render(ui).container.querySelector("svg")!;

describe("CoachAvatar", () => {
  it("renders the mark", () => {
    const svg = svgOf(<CoachAvatar/>);
    expect(svg).not.toBeNull();
    expect(svg.innerHTML).not.toBe("");
  });

  it("wraps in the circular chip when chip is set", () => {
    const { container } = render(<CoachAvatar chip/>);
    const chip = container.firstElementChild!;
    expect(chip.tagName).toBe("DIV");
    expect(chip.className).toContain("rounded-full");
    expect(chip.className).toContain("w-9 h-9");
    expect(chip.querySelector("svg")).not.toBeNull();
  });

  it("chip className overrides the default chip size", () => {
    const { container } = render(<CoachAvatar chip className="w-7 h-7"/>);
    const chip = container.firstElementChild!;
    expect(chip.className).toContain("w-7 h-7");
    expect(chip.className).not.toContain("w-9 h-9");
  });

  it("is decorative by default and labelled with title", () => {
    expect(svgOf(<CoachAvatar/>).getAttribute("aria-hidden")).toBe("true");
    cleanup();
    const svg = svgOf(<CoachAvatar title="Coach"/>);
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.querySelector("title")?.textContent).toBe("Coach");
  });
});
