import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { LiveHrZone } from "./LiveHrZone";

afterEach(cleanup);

// Karvonen on maxHR 200 / restHR 60 (HRR 140): Z1 130-144, Z2 144-158,
// Z3 158-172, Z4 172-186, Z5 186+ — the same bands utils/hr.test.ts pins.
const show = (bpm: number | null, effMax = 200, restHR = 60) =>
  render(<LiveHrZone bpm={bpm} effMax={effMax} restHR={restHR} />);

describe("LiveHrZone", () => {
  it("names the zone the current reading falls in", () => {
    show(150);
    expect(screen.getByText(/aerobic base/i)).toBeInTheDocument();
  });

  it("follows the reading up into the next zone", () => {
    show(180);
    expect(screen.getByText(/threshold/i)).toBeInTheDocument();
    expect(screen.queryByText(/aerobic base/i)).not.toBeInTheDocument();
  });

  it("says there is no reading rather than guessing a zone", () => {
    const { container } = show(null);
    expect(screen.getByText(/no reading/i)).toBeInTheDocument();
    // The strip still renders (all five zones, none highlighted) but nothing
    // claims a position on it.
    expect(container.querySelector(".bg-white")).toBeNull();
  });

  // A bar with no meaning is worse than no bar — same guard as HRZonesCard.
  it("renders nothing without a usable HR profile", () => {
    expect(show(150, 0).container).toBeEmptyDOMElement();
    expect(show(150, 60, 60).container).toBeEmptyDOMElement();   // no heart-rate reserve
    expect(show(150, 50, 60).container).toBeEmptyDOMElement();   // negative reserve
  });

  // The strip draws the five ZONES as equal blocks, so it spans Z1's floor to
  // max HR — not resting HR to max. Labelling it "rest" would misread the
  // marker by a whole zone or two.
  it("anchors the bar at the zone floor, not resting HR", () => {
    show(150, 200, 60);
    expect(screen.getByText(/130 bpm/)).toBeInTheDocument();   // Z1 floor, not 60
    expect(screen.getByText(/200 bpm/)).toBeInTheDocument();
  });

  // Zones are equal 10%-of-reserve bands, so a reading must land in the same
  // 20%-wide block its zone name points at. Mapping across [rest, max] instead
  // put every marker in the wrong block.
  it("puts the marker in the block its zone names", () => {
    const marker = (bpm: number) => {
      cleanup();
      const { container } = show(bpm, 200, 60);
      return parseFloat((container.querySelector<HTMLElement>(".bg-white")!).style.left);
    };
    expect(marker(137)).toBeCloseTo(10, 1);    // mid Z1  → block 1 (0-20%)
    expect(marker(151)).toBeCloseTo(30, 1);    // mid Z2  → block 2 (20-40%)
    expect(marker(179)).toBeCloseTo(70, 1);    // mid Z4  → block 4 (60-80%)
    expect(marker(193)).toBeCloseTo(90, 1);    // mid Z5  → block 5 (80-100%)
  });

  it("parks an out-of-range reading at an end instead of escaping the bar", () => {
    expect(parseFloat(show(90, 200, 60).container.querySelector<HTMLElement>(".bg-white")!.style.left)).toBe(0);
    cleanup();
    expect(parseFloat(show(230, 200, 60).container.querySelector<HTMLElement>(".bg-white")!.style.left)).toBe(100);
  });
});
