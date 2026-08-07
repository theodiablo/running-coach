import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CoachAvatar } from "./CoachAvatar";
import { COACH_MARK_IDS, DEFAULT_COACH_MARK } from "../utils/coachIdentity";

afterEach(cleanup);

const svgOf = (ui: React.ReactElement) => render(ui).container.querySelector("svg")!;

describe("CoachAvatar", () => {
  it("renders a distinct svg for every mark id", () => {
    // Distinctness also catches COACH_MARK_IDS/COACH_MARKS drift: an id with no
    // mark would fall back to the default and collide with it.
    const seen = new Map<string, string>();
    for (const id of COACH_MARK_IDS) {
      const svg = svgOf(<CoachAvatar id={id}/>);
      expect(svg.innerHTML, id).not.toBe("");
      expect([...seen.values()], id).not.toContain(svg.innerHTML);
      seen.set(id, svg.innerHTML);
      cleanup();
    }
  });

  it("falls back to the default mark for unknown or absent ids", () => {
    const def = svgOf(<CoachAvatar id={DEFAULT_COACH_MARK}/>).innerHTML;
    cleanup();
    expect(svgOf(<CoachAvatar id="deleted-mark"/>).innerHTML).toBe(def);
    cleanup();
    expect(svgOf(<CoachAvatar/>).innerHTML).toBe(def);
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
