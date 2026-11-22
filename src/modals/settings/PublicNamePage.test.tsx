import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ save: vi.fn(), fetch: vi.fn() }));
vi.mock("../../db", () => ({ currentUserId: () => "u1" }));
vi.mock("../../publicName", async (orig) => ({
  ...(await orig<typeof import("../../publicName")>()),
  savePublicName: h.save,
  fetchPublicName: h.fetch,
}));

const { PublicNamePage } = await import("./PublicNamePage");

const page = (publicName: string | null | undefined) => {
  const props = { publicName, onSaved: vi.fn(), showToast: vi.fn() };
  render(<PublicNamePage {...props}/>);
  return props;
};

beforeEach(() => { h.save.mockReset().mockResolvedValue(true); h.fetch.mockReset(); });
afterEach(cleanup);

describe("PublicNamePage", () => {
  it("saves a trimmed name and previews it", async () => {
    const props = page(null);
    fireEvent.change(screen.getByLabelText("Name other runners see"), { target: { value: "  Alex   M. " } });
    expect(screen.getByText("Alex M.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(h.save).toHaveBeenCalledWith("u1", "Alex M."));
    expect(props.onSaved).toHaveBeenCalledWith("Alex M.");
  });

  it("says what's wrong inline and won't save it", () => {
    page(null);
    fireEvent.change(screen.getByLabelText("Name other runners see"), { target: { value: "alex.com" } });
    expect(screen.getByText("No links or email addresses.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("removes the name", async () => {
    const props = page("Alex M.");
    fireEvent.click(screen.getByRole("button", { name: "Remove my public name" }));
    await waitFor(() => expect(h.save).toHaveBeenCalledWith("u1", null));
    expect(props.onSaved).toHaveBeenCalledWith(null);
  });

  it("keeps the old name when a save fails", async () => {
    h.save.mockResolvedValue(false);
    const props = page("Alex M.");
    fireEvent.change(screen.getByLabelText("Name other runners see"), { target: { value: "Alex" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(props.showToast).toHaveBeenCalledWith(expect.stringMatching(/Couldn't save/), "error"));
    expect(props.onSaved).not.toHaveBeenCalled();
  });

  it("offers a retry, not an empty field, when the name couldn't be read", async () => {
    h.fetch.mockResolvedValue("Alex M.");
    const props = page(undefined);
    expect(screen.queryByLabelText("Name other runners see")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledWith("Alex M."));
  });
});
