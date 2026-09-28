import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { rpc, signOut, getSession, revokeAppleGrants } = vi.hoisted(() => ({
  rpc: vi.fn(),
  signOut: vi.fn(),
  getSession: vi.fn(),
  revokeAppleGrants: vi.fn(),
}));
vi.mock("../supabase", () => ({ supabase: { rpc, auth: { signOut, getSession } } }));
vi.mock("../auth/appleSignIn", () => ({ revokeAppleGrants }));

import { DeleteAccountModal } from "./DeleteAccountModal";

const session = { user: { identities: [{ provider: "apple" }] } };

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ data: { session } });
  rpc.mockResolvedValue({ error: null });
  signOut.mockResolvedValue({});
  revokeAppleGrants.mockResolvedValue(undefined);
});

describe("DeleteAccountModal", () => {
  it("revokes Apple's grant before the account (and the stored grant) is deleted", async () => {
    const onSignOut = vi.fn();
    render(<DeleteAccountModal onSignOut={onSignOut} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    await waitFor(() => expect(onSignOut).toHaveBeenCalled());
    expect(revokeAppleGrants).toHaveBeenCalledWith(session);
    expect(revokeAppleGrants.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[0]);
    expect(rpc).toHaveBeenCalledWith("delete_my_account");
  });
});
