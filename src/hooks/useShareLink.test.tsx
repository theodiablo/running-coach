import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { useShareLink } from "./useShareLink";

const OLD = "A".repeat(22);
const NEW = "B".repeat(22);
vi.mock("../live/shareLinkStore", () => ({
  readCachedShareLink: () => OLD,
  fetchShareLink: () => Promise.resolve(OLD),
  ensureShareLink: () => Promise.resolve(OLD),
  rotateShareLink: () => Promise.resolve({ token: NEW }),
}));

afterEach(cleanup);

function View({ id }: { id: string }) {
  const link = useShareLink();
  return (
    <div>
      <span data-testid={id}>{link.token}</span>
      <button onClick={() => { void link.replace(); }}>{"replace-" + id}</button>
    </div>
  );
}

describe("useShareLink", () => {
  // The recorder stays mounted over Home: a link replaced in one view must not
  // stay sendable as the revoked address in the other.
  it("carries a replaced link to every mounted view", async () => {
    render(<><View id="recorder"/><View id="home"/></>);
    await waitFor(() => expect(screen.getByTestId("home").textContent).toBe(OLD));
    await act(async () => { fireEvent.click(screen.getByText("replace-recorder")); });
    await waitFor(() => expect(screen.getByTestId("recorder").textContent).toBe(NEW));
    expect(screen.getByTestId("home").textContent).toBe(NEW);
  });
});
