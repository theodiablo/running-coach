import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Coachmark } from "./Coachmark";
import { dismissTop } from "../utils/backDismiss";

afterEach(cleanup);

const setup = () => {
  const onDismiss = vi.fn();
  render(<Coachmark title="Your coach lives here" body="Tell it what happened." cta="Got it" onDismiss={onDismiss}/>);
  return onDismiss;
};

describe("Coachmark", () => {
  it("shows what it is pointing at and how to answer it", () => {
    setup();
    expect(screen.getByText("Your coach lives here")).toBeInTheDocument();
    expect(screen.getByText("Tell it what happened.")).toBeInTheDocument();
    expect(screen.getByRole("button", {name: "Got it"})).toBeInTheDocument();
  });

  it.each([
    ["Got it", "the CTA"],
    ["Dismiss", "the close button"],
  ])("dismisses on %s", label => {
    const onDismiss = setup();
    fireEvent.click(screen.getByRole("button", {name: label}));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("offers exactly one named dismiss control", () => {
    // The dimmer duplicates the close button for anyone who can see it, so it
    // stays out of the accessibility tree rather than announcing a second,
    // indistinguishable "Dismiss".
    setup();
    expect(screen.getAllByRole("button", {name: "Dismiss"})).toHaveLength(1);
  });

  it("dismisses on Android back / Escape", () => {
    // A pointer the hardware back button can't clear would trap the user on it.
    const onDismiss = setup();
    expect(dismissTop()).toBe(true);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps the control it points at above the dimmer", () => {
    // The whole design: the header (z-20) stays lit and tappable, so tapping the
    // Coach pill is a valid way to answer the pointer. A dimmer at or above z-20
    // would swallow that tap.
    const { container } = render(
      <Coachmark title="t" body="b" cta="c" onDismiss={vi.fn()}/>);
    const dimmer = container.querySelector("button[aria-hidden]")!;
    expect(dimmer.className).toContain("z-10");
    expect(screen.getByRole("dialog").className).toContain("z-30");
  });
});
