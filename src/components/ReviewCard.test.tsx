import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../native", () => ({ isIos: false }));

import { ReviewCard } from "./ReviewCard";

describe("ReviewCard", () => {
  it("speaks in the developer's voice and names the store", () => {
    render(<ReviewCard ask={1} onSeen={vi.fn()} onAnswer={vi.fn()}/>);
    expect(screen.getByText(/I build Running Coach myself/)).toBeInTheDocument();
    expect(screen.getByText(/Google Play/)).toBeInTheDocument();
  });

  it("asks no question before the button", () => {
    render(<ReviewCard ask={1} onSeen={vi.fn()} onAnswer={vi.fn()}/>);
    expect(screen.getByRole("status").textContent).not.toMatch(/\?/);
  });

  it("counts the ask once it is on screen", () => {
    const onSeen = vi.fn();
    render(<ReviewCard ask={1} onSeen={onSeen} onAnswer={vi.fn()}/>);
    expect(onSeen).toHaveBeenCalledOnce();
  });

  it("first ask: review or not now", () => {
    const onAnswer = vi.fn();
    render(<ReviewCard ask={1} onSeen={vi.fn()} onAnswer={onAnswer}/>);
    expect(screen.queryByRole("button", { name: "Don't ask again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Leave a review" }));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onAnswer.mock.calls).toEqual([["review"], ["later"]]);
  });

  it("later asks also offer a way to stop for good", () => {
    const onAnswer = vi.fn();
    render(<ReviewCard ask={2} onSeen={vi.fn()} onAnswer={onAnswer}/>);
    fireEvent.click(screen.getByRole("button", { name: "Don't ask again" }));
    expect(onAnswer).toHaveBeenCalledWith("never");
  });
});
