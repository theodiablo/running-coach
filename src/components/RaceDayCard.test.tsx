import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RaceDayCard } from "./RaceDayCard";
import { LIVE_SHARE_KEY } from "../constants";
import type { Participation } from "../types";

vi.mock("../live/shareLinkStore", () => ({
  readCachedShareLink: () => null,
  fetchShareLink: () => Promise.resolve(null),
  ensureShareLink: () => Promise.resolve(null),
  rotateShareLink: () => Promise.resolve({ token: null }),
}));

afterEach(cleanup);
beforeEach(() => { localStorage.clear(); localStorage.setItem(LIVE_SHARE_KEY, "1"); });

const race: Participation = { editionId: "paris-20k-2026-11-09", label: "20 km de Paris", raceDate: "2026-11-09", distanceKm: 20, status: "wishlist" };

const setup = (props: Partial<Parameters<typeof RaceDayCard>[0]> = {}) => {
  const onStart = vi.fn();
  render(<RaceDayCard race={race} today="2026-11-02" linkSent={false} testDone={false}
    onLinkSent={vi.fn()} onStart={onStart} showToast={vi.fn()} {...props}/>);
  return { onStart };
};

describe("RaceDayCard", () => {
  it("counts down to the race and offers a test run before it", () => {
    const { onStart } = setup();
    expect(screen.getByText("20 km de Paris")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("Send your follow link")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Test"));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Start a run · shared live")).toBeInTheDocument();
  });

  it("says start my race on the day, once the test is done and the link sent", () => {
    setup({ today: "2026-11-09", testDone: true, linkSent: true });
    expect(screen.getByText("Today!")).toBeInTheDocument();
    expect(screen.queryByText("Do a 2-minute test run")).not.toBeInTheDocument();
    expect(screen.getByText("Follow link sent")).toBeInTheDocument();
    expect(screen.getByText("Start my race · shared live")).toBeInTheDocument();
  });

  it("falls back to live sharing alone with no race, and flags sharing off on this phone", () => {
    localStorage.setItem(LIVE_SHARE_KEY, "0");
    setup({ race: null });
    expect(screen.getByText("Share your next run live")).toBeInTheDocument();
    expect(screen.getByText(/Sharing is off on this phone/)).toBeInTheDocument();
    expect(screen.getByText("Start a run")).toBeInTheDocument();
  });
});
