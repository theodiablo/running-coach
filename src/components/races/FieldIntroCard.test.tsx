import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { MyMembership, RaceFieldState } from "../../raceField";

const h = vi.hoisted(() => ({
  races: [] as { name: string; editions: { id: string; verified?: boolean }[] }[],
  mine: {} as Record<string, MyMembership | null | undefined>,
  field: null as RaceFieldState | null,
  setFieldChoice: vi.fn(),
}));
vi.mock("../../db", () => ({ currentUserId: () => "u1" }));
vi.mock("../../races", () => ({ listKnownRaces: vi.fn(async () => h.races) }));
vi.mock("../../raceField", () => ({
  fetchMyMembership: vi.fn(async (_u: string, id: string) => (id in h.mine ? h.mine[id] : null)),
  fetchRaceField: vi.fn(async () => h.field),
  setFieldChoice: h.setFieldChoice,
}));

const { FieldIntroCard } = await import("./FieldIntroCard");

const card = (p: Partial<React.ComponentProps<typeof FieldIntroCard>> = {}) => {
  const props = { candidates: ["e1"], goals: { e1: 6300 }, publicName: "Alex M." as string | null | undefined,
    onSeen: vi.fn(), onSetName: vi.fn(), showToast: vi.fn(), ...p };
  render(<FieldIntroCard {...props}/>);
  return props;
};
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  h.races = [{ name: "Marseille-Cassis", editions: [{ id: "e1", verified: true }] }];
  h.mine = {}; h.field = { open: true, joined: false, count: 7, named: [] };
  h.setFieldChoice.mockReset().mockResolvedValue("ok");
});
afterEach(cleanup);

describe("FieldIntroCard", () => {
  it("introduces an open field by its race and count, and is spent once seen", async () => {
    const props = card();
    expect(await screen.findByText("7 other app runners are doing Marseille-Cassis")).toBeInTheDocument();
    await waitFor(() => expect(props.onSeen).toHaveBeenCalled());
  });

  it("invites a runner to be one of the first in a closed field", async () => {
    h.field = { open: false, joined: false, count: null, named: [] };
    card();
    expect(await screen.findByText("Be one of the first app runners in the Marseille-Cassis field")).toBeInTheDocument();
  });

  it("skips an unverified race for the next verified one", async () => {
    h.races = [{ name: "Unverified", editions: [{ id: "e1" }] }, { name: "Verified 10K", editions: [{ id: "e2", verified: true }] }];
    card({ candidates: ["e1", "e2"] });
    expect(await screen.findByText(/Verified 10K/)).toBeInTheDocument();
  });

  it("shows nothing, and spends itself, for a runner already in that field", async () => {
    h.mine = { e1: { visibility: "count", goalSec: null } };
    const props = card();
    await waitFor(() => expect(props.onSeen).toHaveBeenCalled());
    expect(document.body.textContent).toBe("");
  });

  it("shows nothing, and stays unspent, when a read fails", async () => {
    h.mine = { e1: undefined };
    const props = card();
    await flush(); await flush();
    expect(document.body.textContent).toBe("");
    expect(props.onSeen).not.toHaveBeenCalled();
  });

  it("opens the join sheet and saves the choice for that race", async () => {
    card();
    fireEvent.click(await screen.findByRole("button", { name: "Choose how I appear" }));
    fireEvent.click(screen.getByRole("radio", { name: /Just count me/ }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(h.setFieldChoice).toHaveBeenCalledWith("u1", "e1", "count", null, null));
    await waitFor(() => expect(screen.queryByText(/Marseille-Cassis/)).toBeNull());
  });

  it("goes away on Not now", async () => {
    const props = card();
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByText(/Marseille-Cassis/)).toBeNull();
    expect(props.onSeen).toHaveBeenCalled();
  });
});
