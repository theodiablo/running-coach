import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { MyMembership, RaceFieldState } from "../../raceField";

const h = vi.hoisted(() => ({
  field: null as RaceFieldState | null,
  mine: null as MyMembership | null | undefined,
  setFieldChoice: vi.fn(),
  reportRace: vi.fn(),
}));
vi.mock("../../db", () => ({ currentUserId: () => "u1" }));
vi.mock("../../races", () => ({ reportRace: h.reportRace }));
vi.mock("../../raceField", async (orig) => ({
  ...(await orig<typeof import("../../raceField")>()),
  fetchRaceField: vi.fn(async () => h.field),
  fetchMyMembership: vi.fn(async () => h.mine),
  setFieldChoice: h.setFieldChoice,
}));

const { RaceFieldCard } = await import("./RaceFieldCard");
const { fetchRaceField } = await import("../../raceField");

type CardProps = Partial<React.ComponentProps<typeof RaceFieldCard>>;
const card = (p: CardProps = {}) => {
  const props = { editionId: "e1", listed: true, ask: false, publicName: "Alex M.", goalSec: 6300,
    onAsked: vi.fn(), onSetName: vi.fn(), showToast: vi.fn(), ...p };
  render(<RaceFieldCard {...props}/>);
  return props;
};

beforeEach(() => { h.field = null; h.mine = null; h.setFieldChoice.mockReset().mockResolvedValue("ok"); h.reportRace.mockReset().mockResolvedValue(undefined); });
afterEach(cleanup);

describe("RaceFieldCard", () => {
  it("shows the count once the field is open", async () => {
    h.field = { open: true, joined: true, count: 9, named: [] };
    h.mine = { visibility: "count", goalSec: null };
    card();
    expect(await screen.findByText("9 app runners in this field")).toBeInTheDocument();
    expect(screen.getByText("You're one of them")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change how I appear" })).toBeInTheDocument();
  });

  it("tells a runner who joined a closed field that it opens later, with no number", async () => {
    h.field = { open: false, joined: true, count: null, named: [] };
    h.mine = { visibility: "count", goalSec: null };
    card();
    expect(await screen.findByText(/We'll show the field once a few more app runners join/)).toBeInTheDocument();
    expect(screen.queryByText(/app runners in this field$/)).toBeNull();
  });

  it("shows only the count to someone who hasn't listed the race", async () => {
    h.field = { open: true, joined: false, count: 4, named: [] };
    card({ listed: false });
    expect(await screen.findByText("4 app runners in this field")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows nothing for a closed field the runner can't join", async () => {
    h.field = { open: false, joined: false, count: null, named: [] };
    card({ listed: false });
    await waitFor(() => expect(fetchRaceField).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 0));
    expect(document.body.textContent).toBe("");
  });

  it("offers no join or change while the public name is unread, so a named choice can't be lost", async () => {
    h.field = { open: true, joined: true, count: 5, named: [] };
    h.mine = { visibility: "named", goalSec: 6300 };
    card({ publicName: undefined });
    expect(await screen.findByText("5 app runners in this field")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change how I appear" })).toBeNull();
  });

  it("hides the card when the field read failed, rather than guess its state", async () => {
    h.field = null;
    h.mine = { visibility: "count", goalSec: null };
    card();
    await waitFor(() => expect(fetchRaceField).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 0));
    expect(document.body.textContent).toBe("");
  });

  it("hides the door when the membership read failed, rather than offering a second join", async () => {
    h.field = { open: false, joined: false, count: null, named: [] };
    h.mine = undefined;
    card();
    await new Promise(r => setTimeout(r, 0));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("asks once when the race was just added, goal off until turned on", async () => {
    h.field = { open: true, joined: false, count: 8, named: [] };
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
    h.field = { open: false, joined: false, count: null, named: [] };
    const props = card({ ask: true, publicName: null });
    const named = await screen.findByRole("radio", { name: /Show me by name/ });
    expect(named).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Just count me/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set a public name" }));
    expect(props.onSetName).toHaveBeenCalled();
  });

  it("offers the goal only under the named choice", async () => {
    h.field = { open: false, joined: false, count: null, named: [] };
    card({ ask: true });
    expect(await screen.findByRole("switch", { name: "Show my goal time" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Just count me/ }));
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(h.setFieldChoice).toHaveBeenCalledWith("u1", "e1", "count", null, null));
  });

  it("says why a join was refused and keeps the sheet open", async () => {
    h.field = { open: false, joined: false, count: null, named: [] };
    h.setFieldChoice.mockResolvedValue("limit");
    const props = card({ ask: true });
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => expect(props.showToast).toHaveBeenCalledWith(expect.stringMatching(/30 upcoming race fields/), "error"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("leaves the field with Not this time", async () => {
    h.field = { open: true, joined: true, count: 5, named: [] };
    h.mine = { visibility: "named", goalSec: 6300 };
    card();
    fireEvent.click(await screen.findByRole("button", { name: "Change how I appear" }));
    fireEvent.click(screen.getByRole("radio", { name: /Not this time/ }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(h.setFieldChoice).toHaveBeenCalledWith("u1", "e1", "none", null, { visibility: "named", goalSec: 6300 }));
  });
  it("opens who's running for a runner who joined: names, goals, the unnamed rest and the near-goal line", async () => {
    h.field = { open: true, joined: true, count: 6, named: [
      { name: "Zoé L.", goalSec: 6200, me: false },
      { name: "Alex M.", goalSec: 6300, me: true },
      { name: "Sam K.", goalSec: null, me: false },
    ] };
    h.mine = { visibility: "named", goalSec: 6300 };
    card();
    fireEvent.click(await screen.findByRole("button", { name: "See who's running" }));
    const list = screen.getByRole("dialog", { name: "Who's running" });
    expect(list).toHaveTextContent("Zoé L.");
    expect(list).toHaveTextContent("Goal 1:43:20");
    expect(list).toHaveTextContent("And 3 more who joined without a name.");
    expect(list).toHaveTextContent("1 other aims for about your time");
    expect(list).toHaveTextContent("You appear as Alex M.");
    expect(screen.queryByRole("button", { name: "Report the name Alex M." })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Report the name Zoé L." }));
    expect(screen.getByRole("group", { name: "Report" })).toHaveFocus();
  });

  it("offers no Change from the list when the race isn't on the runner's list", async () => {
    h.field = { open: true, joined: true, count: 4, named: [] };
    card({ listed: false });
    fireEvent.click(await screen.findByRole("button", { name: "See who's running" }));
    expect(screen.getByRole("dialog", { name: "Who's running" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change how I appear" })).toBeNull();
  });

  it("offers no list to a runner who hasn't joined, even when the field is open", async () => {
    h.field = { open: true, joined: false, count: 4, named: [] };
    card();
    expect(await screen.findByText("4 app runners in this field")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "See who's running" })).toBeNull();
  });

  it("reports a name by its text only, after a confirm", async () => {
    h.field = { open: true, joined: true, count: 4, named: [{ name: "Bad Name", goalSec: null, me: false }] };
    h.mine = { visibility: "count", goalSec: null };
    const props = card();
    fireEvent.click(await screen.findByRole("button", { name: "See who's running" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("You're counted, without a name");
    fireEvent.click(screen.getByRole("button", { name: "Report the name Bad Name" }));
    expect(h.reportRace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    await waitFor(() => expect(h.reportRace).toHaveBeenCalledWith({ editionId: "e1", reason: "field_name", note: "Bad Name" }));
    await waitFor(() => expect(props.showToast).toHaveBeenCalledWith("Thanks. We'll take a look at that name."));
  });
});
