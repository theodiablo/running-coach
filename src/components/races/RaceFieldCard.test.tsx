import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { MyMembership, RaceFieldState } from "../../raceField";

const h = vi.hoisted(() => ({
  field: null as RaceFieldState | null,
  mine: null as MyMembership | null | undefined,
  setFieldChoice: vi.fn(),
}));
vi.mock("../../db", () => ({ currentUserId: () => "u1" }));
vi.mock("../../raceField", () => ({
  fetchRaceField: vi.fn(async () => h.field),
  fetchMyMembership: vi.fn(async () => h.mine),
  setFieldChoice: h.setFieldChoice,
}));

const { RaceFieldCard } = await import("./RaceFieldCard");

type CardProps = Partial<React.ComponentProps<typeof RaceFieldCard>>;
const card = (p: CardProps = {}) => {
  const props = { editionId: "e1", listed: true, ask: false, publicName: "Alex M.", goalSec: 6300,
    onAsked: vi.fn(), onSetName: vi.fn(), showToast: vi.fn(), ...p };
  render(<RaceFieldCard {...props}/>);
  return props;
};

beforeEach(() => { h.field = null; h.mine = null; h.setFieldChoice.mockReset().mockResolvedValue("ok"); });
afterEach(cleanup);

describe("RaceFieldCard", () => {
  it("shows the count once the field is open", async () => {
    h.field = { open: true, joined: true, count: 9 };
    h.mine = { visibility: "count", goalSec: null };
    card();
    expect(await screen.findByText("9 app runners in this field")).toBeInTheDocument();
    expect(screen.getByText("You're one of them")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change how I appear" })).toBeInTheDocument();
  });

  it("tells a runner who joined a closed field that it opens later, with no number", async () => {
    h.field = { open: false, joined: true, count: null };
    h.mine = { visibility: "count", goalSec: null };
    card();
    expect(await screen.findByText(/We'll show the field once a few more app runners join/)).toBeInTheDocument();
    expect(screen.queryByText(/app runners in this field$/)).toBeNull();
  });

  it("shows only the count to someone who hasn't listed the race", async () => {
    h.field = { open: true, joined: false, count: 4 };
    card({ listed: false });
    expect(await screen.findByText("4 app runners in this field")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows nothing for a closed field the runner can't join", async () => {
    h.field = { open: false, joined: false, count: null };
    const { container } = render(<div/>);
    card({ listed: false });
    await waitFor(() => expect(container.ownerDocument.body.textContent).toBe(""));
  });

  it("hides the door when the membership read failed, rather than offering a second join", async () => {
    h.field = { open: false, joined: false, count: null };
    h.mine = undefined;
    card();
    await new Promise(r => setTimeout(r, 0));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("asks once when the race was just added, goal off until turned on", async () => {
    h.field = { open: true, joined: false, count: 8 };
    const props = card({ ask: true });
    expect(await screen.findByRole("dialog", { name: "Running with others from the app" })).toBeInTheDocument();
    expect(screen.getByText(/8 other app runners have joined/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Show me as Alex M\./ })).toHaveAttribute("aria-checked", "true");
    const goal = screen.getByRole("switch", { name: "Show my goal time" });
    expect(goal).toHaveAttribute("aria-checked", "false");
    fireEvent.click(goal);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(h.setFieldChoice).toHaveBeenCalledWith("u1", "e1", "named", 6300, null));
    await waitFor(() => expect(props.onAsked).toHaveBeenCalled());
  });

  it("can't join by name without a public name, and points to setting one", async () => {
    h.field = { open: false, joined: false, count: null };
    const props = card({ ask: true, publicName: null });
    const named = await screen.findByRole("radio", { name: /Show me by name/ });
    expect(named).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Just count me/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set a public name" }));
    expect(props.onSetName).toHaveBeenCalled();
  });

  it("offers the goal only under the named choice", async () => {
    h.field = { open: false, joined: false, count: null };
    card({ ask: true });
    expect(await screen.findByRole("switch", { name: "Show my goal time" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Just count me/ }));
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(h.setFieldChoice).toHaveBeenCalledWith("u1", "e1", "count", null, null));
  });

  it("says why a join was refused and keeps the sheet open", async () => {
    h.field = { open: false, joined: false, count: null };
    h.setFieldChoice.mockResolvedValue("limit");
    const props = card({ ask: true });
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => expect(props.showToast).toHaveBeenCalledWith(expect.stringMatching(/30 upcoming race fields/), "error"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("leaves the field with Not this time", async () => {
    h.field = { open: true, joined: true, count: 5 };
    h.mine = { visibility: "named", goalSec: 6300 };
    card();
    fireEvent.click(await screen.findByRole("button", { name: "Change how I appear" }));
    fireEvent.click(screen.getByRole("radio", { name: /Not this time/ }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(h.setFieldChoice).toHaveBeenCalledWith("u1", "e1", "none", null, { visibility: "named", goalSec: 6300 }));
  });
});
