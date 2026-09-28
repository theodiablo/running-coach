import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { signOut, updateUser } = vi.hoisted(() => ({
  signOut: vi.fn(async () => ({ error: null })),
  updateUser: vi.fn(async () => ({ error: null })),
}));
vi.mock("./supabase", () => ({ supabase: { auth: { signOut, updateUser } } }));

import ResetPasswordScreen from "./ResetPasswordScreen";

describe("ResetPasswordScreen", () => {
  beforeEach(() => { signOut.mockClear(); updateUser.mockClear(); });

  it("names the account the link signed into and offers a way out of it", async () => {
    const onDone = vi.fn();
    render(<ResetPasswordScreen email="someone@example.com" onDone={onDone} />);
    expect(screen.getByText(/Signed in as someone@example.com/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Not your account? Sign out" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(updateUser).not.toHaveBeenCalled();
  });
});
