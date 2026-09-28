import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { AccountPage } from "./AccountPage";
import type { SettingsState } from "../../types";
import type { User, UserIdentity } from "@supabase/supabase-js";

const updateUser = vi.fn();
const refreshSession = vi.fn();
vi.mock("../../supabase", () => ({
  supabase: { auth: {
    updateUser: (...args: unknown[]) => updateUser(...args),
    refreshSession: (...args: unknown[]) => refreshSession(...args),
  } },
  authRedirectTo: () => "https://run.example/",
}));

const TOKEN = "A".repeat(22);
const cachedLink = vi.fn<() => string | null>(() => null);
vi.mock("../../live/shareLinkStore", () => ({
  readCachedShareLink: () => cachedLink(),
  fetchShareLink: () => Promise.resolve(null),
  rotateShareLink: () => Promise.resolve({ token: null }),
}));

afterEach(cleanup);
beforeEach(() => {
  updateUser.mockReset(); updateUser.mockResolvedValue({ error: null });
  refreshSession.mockReset(); refreshSession.mockResolvedValue({ data: { session: null }, error: null });
});

const makeUser = (providers: string[], extra: Partial<User> = {}) => ({
  email: "runner@example.com",
  identities: providers.map(provider => ({ provider } as UserIdentity)),
  ...extra,
} as User);

const renderPage = (user?: User) => render(
  <AccountPage settings={{} as SettingsState} saveSettings={() => {}} user={user}
    onBackup={() => {}} onRestore={() => {}} />
);

describe("AccountPage credentials", () => {
  it("offers to SET a password for a Google-only account", () => {
    renderPage(makeUser(["google"]));
    expect(screen.getByText("Set a password")).toBeInTheDocument();
    expect(screen.getByText("You sign in with Google. Add a password to also sign in with your email.")).toBeInTheDocument();
  });

  it("offers to CHANGE the password once an email identity exists", () => {
    renderPage(makeUser(["email"]));
    expect(screen.queryByText("Set a password")).toBeNull();
    expect(screen.getByText("Password")).toBeInTheDocument();
  });

  it("hides the credential card entirely without a session user", () => {
    renderPage(undefined);
    expect(screen.queryByText("Sign-in details")).toBeNull();
    // The rest of the page still renders.
    expect(screen.getByText("Backup & restore")).toBeInTheDocument();
  });
});

describe("AccountPage password form", () => {
  const openForm = () => {
    renderPage(makeUser(["email"]));
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  };
  const fill = (pw: string, confirm: string) => {
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: pw } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: confirm } });
    fireEvent.submit(screen.getByLabelText("New password").closest("form")!);
  };

  it("rejects a too-short password without calling Supabase", async () => {
    openForm();
    fill("Abcdefghij1", "Abcdefghij1"); // 11 chars
    await screen.findByText("At least 12 characters, with an uppercase letter, a lowercase letter and a digit.");
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("rejects a mismatched confirmation without calling Supabase", async () => {
    openForm();
    fill("Abcdefghijk1", "Abcdefghijk2");
    await screen.findByText("The two passwords don't match.");
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("submits a compliant password", async () => {
    openForm();
    fill("Abcdefghijk1", "Abcdefghijk1");
    await waitFor(() => expect(updateUser).toHaveBeenCalledWith({ password: "Abcdefghijk1" }));
  });
});

describe("AccountPage email form", () => {
  it("sends the change with the platform redirect target", async () => {
    renderPage(makeUser(["email"]));
    fireEvent.click(screen.getByRole("button", { name: "Change email" }));
    fireEvent.change(screen.getByLabelText("New email address"), { target: { value: "new@example.com" } });
    fireEvent.submit(screen.getByLabelText("New email address").closest("form")!);
    await waitFor(() => expect(updateUser).toHaveBeenCalledWith(
      { email: "new@example.com" }, { emailRedirectTo: "https://run.example/" }));
  });

  it("names the mailer rate limit rather than showing the raw error", async () => {
    updateUser.mockResolvedValue({ error: { status: 429, message: "email rate limit exceeded" } });
    renderPage(makeUser(["email"]));
    fireEvent.click(screen.getByRole("button", { name: "Change email" }));
    fireEvent.change(screen.getByLabelText("New email address"), { target: { value: "new@example.com" } });
    fireEvent.submit(screen.getByLabelText("New email address").closest("form")!);
    await screen.findByText(/We've sent all the emails we can for now/);
  });

  it("names the inbox holding the link while a change is unconfirmed", () => {
    renderPage(makeUser(["email"], { new_email: "new@example.com" }));
    expect(screen.getByText(/Open the link we sent to new@example.com/)).toBeInTheDocument();
  });

  // `user` comes from the cached session, and the link is opened in the NEW
  // inbox — often another device — so without this the pending note stays up on
  // an account that has already changed.
  it("re-reads the account on mount while a change is pending", async () => {
    renderPage(makeUser(["email"], { new_email: "new@example.com" }));
    await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1));
  });

  it("does not re-read the account when nothing is pending", async () => {
    renderPage(makeUser(["email"]));
    await waitFor(() => expect(screen.getByText("Email")).toBeInTheDocument());
    expect(refreshSession).not.toHaveBeenCalled();
  });
});

describe("AccountPage share link", () => {
  beforeEach(() => { cachedLink.mockReset(); cachedLink.mockReturnValue(null); });

  it("copies the watch URL to the clipboard", async () => {
    cachedLink.mockReturnValue(TOKEN);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Copied/ })).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`/watch/${TOKEN}$`)));
  });

  it("shows the URL in a toast when the clipboard is unavailable", async () => {
    cachedLink.mockReturnValue(TOKEN);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true,
    });
    const showToast = vi.fn();
    render(<AccountPage settings={{} as SettingsState} saveSettings={() => {}}
      onBackup={() => {}} onRestore={() => {}} showToast={showToast} />);
    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining(`/watch/${TOKEN}`)));
  });

  it("renders no share-link card without a link", () => {
    renderPage();
    expect(screen.queryByRole("button", { name: /Copy link/ })).not.toBeInTheDocument();
  });
});
