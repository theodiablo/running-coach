import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const { signUp, signInWithPassword, signInWithOAuth, resetPasswordForEmail } = vi.hoisted(() => ({
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  signInWithOAuth: vi.fn(),
  resetPasswordForEmail: vi.fn(),
}));
vi.mock("./supabase", () => ({
  supabase: { auth: { signUp, signInWithPassword, signInWithOAuth, resetPasswordForEmail } },
  authRedirectTo: () => "http://localhost/",
}));
vi.mock("./native", () => ({ isNative: false, isAndroid: false }));

import LoginScreen from "./LoginScreen";

const submitButton = () => document.querySelector("form button[type=submit]") as HTMLButtonElement;
const STRONG = "Correct9Horse";

const type = (email = "runner@example.com", password = STRONG) => {
  fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: email } });
  fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: password } });
};
const invalidCredentials = () => ({
  error: Object.assign(new Error("Invalid login credentials"), { code: "invalid_credentials", status: 400 }),
});

beforeEach(() => {
  vi.clearAllMocks();
  signUp.mockResolvedValue({ error: null });
  signInWithPassword.mockResolvedValue({ error: null });
  resetPasswordForEmail.mockResolvedValue({ error: null });
});

describe("LoginScreen — one form", () => {
  it("tries to sign in first, so a returning user never picks a branch", async () => {
    render(<LoginScreen />);
    type();
    fireEvent.click(submitButton());

    expect(signInWithPassword).toHaveBeenCalledWith({ email: "runner@example.com", password: STRONG });
    expect(signUp).not.toHaveBeenCalled();
    // Nothing to choose before submitting: the old tab bar is gone.
    expect(screen.queryByRole("button", { name: "Sign up" })).not.toBeInTheDocument();
  });

  it("offers both ways out when the credentials don't match, without guessing which", async () => {
    // GoTrue answers the same for "no account" and "wrong password" on purpose,
    // so the screen asks the one party who knows.
    signInWithPassword.mockResolvedValue(invalidCredentials());
    render(<LoginScreen />);
    type();
    fireEvent.click(submitButton());

    await screen.findByText(/don't match an account/);
    expect(screen.getByRole("button", { name: "Create an account with this email" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send me a reset link" })).toBeInTheDocument();
    // Never the raw server string, and never a claim about which half was wrong.
    expect(screen.queryByText(/Invalid login credentials/)).not.toBeInTheDocument();
  });

  it("creates the account from the fork with the credentials already typed", async () => {
    signInWithPassword.mockResolvedValue(invalidCredentials());
    render(<LoginScreen />);
    type();
    fireEvent.click(submitButton());

    fireEvent.click(await screen.findByRole("button", { name: "Create an account with this email" }));

    await screen.findByText("Check your inbox");
    expect(signUp).toHaveBeenCalledWith(expect.objectContaining({ email: "runner@example.com", password: STRONG }));
  });

  it("holds a weak password back from sign-up rather than letting the server reject it", async () => {
    signInWithPassword.mockResolvedValue(invalidCredentials());
    render(<LoginScreen />);
    type("runner@example.com", "hunter2");
    fireEvent.click(submitButton());

    fireEvent.click(await screen.findByRole("button", { name: "Create an account with this email" }));

    expect(signUp).not.toHaveBeenCalled();
    expect(screen.getAllByText(/At least 12 characters/).length).toBeGreaterThan(0);
  });

  it("drops the fork as soon as the pair it was about changes", async () => {
    signInWithPassword.mockResolvedValue(invalidCredentials());
    render(<LoginScreen />);
    type();
    fireEvent.click(submitButton());
    await screen.findByText(/don't match an account/);

    fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: "AnotherOne99" } });

    expect(screen.queryByText(/don't match an account/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Forgot your password/ })).toBeInTheDocument();
  });

  it("offers a way in when sign-up hits an address that already has an account", async () => {
    signUp.mockResolvedValue({
      error: Object.assign(new Error("User already registered"), { code: "email_exists", status: 422 }),
    });
    render(<LoginScreen intent="signup" />);
    type();
    fireEvent.click(submitButton());

    fireEvent.click(await screen.findByRole("button", { name: "Sign in instead" }));

    expect(signInWithPassword).toHaveBeenCalledWith({ email: "runner@example.com", password: STRONG });
  });
});

describe("LoginScreen — password reset", () => {
  it("never claims an email was sent to an address the server won't confirm exists", async () => {
    render(<LoginScreen />);
    fireEvent.click(screen.getByRole("button", { name: /Forgot your password/ }));
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "runner@example.com" } });
    fireEvent.click(submitButton());

    await screen.findByText("Check your inbox");
    expect(resetPasswordForEmail).toHaveBeenCalledWith("runner@example.com", { redirectTo: "http://localhost/" });
    expect(screen.getByText(/If an account uses runner@example\.com/)).toBeInTheDocument();
    // Same anti-retry rule as sign-up: the mailer is capped, so leave nothing
    // to press again.
    expect(screen.queryByRole("button", { name: "Send reset link" })).not.toBeInTheDocument();
  });

  it("says an email is on its way instead of the raw cooldown string", async () => {
    resetPasswordForEmail.mockResolvedValue({
      error: Object.assign(new Error("For security purposes, you can only request this after 52 seconds."), {
        code: "over_email_send_rate_limit",
        status: 429,
      }),
    });
    render(<LoginScreen />);
    fireEvent.click(screen.getByRole("button", { name: /Forgot your password/ }));
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "runner@example.com" } });
    fireEvent.click(submitButton());

    const note = await screen.findByText(/We just sent you an email/);
    expect(note).toHaveClass("text-amber-400");
    expect(screen.getByText(/52s/)).toBeInTheDocument();
  });

  it("opens on the reset form when the link that brought the user here was dead", () => {
    render(<LoginScreen resetLinkFailed />);

    expect(screen.getByText(/expired or has already been used/)).toBeInTheDocument();
    expect(submitButton()).toHaveTextContent("Send reset link");
  });

  it("surfaces a dead link that is judged dead after the screen is already up", () => {
    // The native shell's order of events: LoginScreen is mounted, then the deep
    // link is redeemed and refused.
    const { rerender } = render(<LoginScreen />);
    expect(screen.queryByText(/expired or has already been used/)).not.toBeInTheDocument();

    rerender(<LoginScreen resetLinkFailed />);

    expect(screen.getByText(/expired or has already been used/)).toBeInTheDocument();
    expect(submitButton()).toHaveTextContent("Send reset link");
  });
});

describe("LoginScreen — sign-up", () => {
  const signUpAndSubmit = (email = "runner@example.com") => {
    type(email);
    fireEvent.click(submitButton());
  };

  it("replaces the form with where the link went, leaving nothing to press again", async () => {
    // The regression: a one-line "check your email" note under a live Create
    // account button. One user pressed it six more times and collected a 429
    // each time, ending on "email rate limit exceeded".
    render(<LoginScreen intent="signup" />);
    signUpAndSubmit();

    await screen.findByText("Check your inbox");
    expect(screen.getByText(/runner@example\.com/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create account" })).not.toBeInTheDocument();
  });

  it("offers a way back to fix a typo'd address", async () => {
    render(<LoginScreen intent="signup" />);
    signUpAndSubmit("typo@exmaple.com");
    await screen.findByText("Check your inbox");

    fireEvent.click(screen.getByRole("button", { name: "Use a different address" }));

    expect(screen.queryByText("Check your inbox")).not.toBeInTheDocument();
    // The address is still in the field, so it can be corrected rather than retyped.
    expect(screen.getByPlaceholderText("you@example.com")).toHaveValue("typo@exmaple.com");
  });

  it("says an email is already on its way instead of the raw cooldown string", async () => {
    signUp.mockResolvedValue({
      error: Object.assign(new Error("For security purposes, you can only request this after 52 seconds."), {
        code: "over_email_send_rate_limit",
        status: 429,
      }),
    });

    render(<LoginScreen intent="signup" />);
    signUpAndSubmit();

    await screen.findByText(/We just sent you an email/);
    expect(screen.getByText(/52s/)).toBeInTheDocument();
    expect(screen.queryByText(/For security purposes/)).not.toBeInTheDocument();
    // Still on the form: the send failed, so there is nothing to wait for.
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
  });

  it("styles a cooldown as a wait, not as a failure", async () => {
    // "We just sent you an email" printed in error red reads as "it went
    // wrong", which sends the user straight back to the button.
    signUp.mockResolvedValue({
      error: Object.assign(new Error("For security purposes, you can only request this after 9 seconds."), {
        code: "over_email_send_rate_limit",
        status: 429,
      }),
    });

    render(<LoginScreen intent="signup" />);
    signUpAndSubmit();

    const note = await screen.findByText(/We just sent you an email/);
    expect(note).toHaveClass("text-amber-400");
    expect(note).not.toHaveClass("text-red-400");
  });

  it("still styles a real failure as one", async () => {
    signUp.mockResolvedValue({
      error: Object.assign(new Error("Error sending confirmation email"), {
        code: "unexpected_failure",
        status: 500,
      }),
    });

    render(<LoginScreen intent="signup" />);
    signUpAndSubmit();

    expect(await screen.findByText(/couldn't send that email/)).toHaveClass("text-red-400");
  });

  it("keeps the server's own message when nothing maps", async () => {
    signUp.mockResolvedValue({
      error: Object.assign(new Error("Signups not allowed for this instance"), {
        code: "signup_disabled",
        status: 422,
      }),
    });

    render(<LoginScreen intent="signup" />);
    signUpAndSubmit();

    await screen.findByText("Signups not allowed for this instance");
  });

  it("does not claim an email was sent when the failure is a sign-in limiter", async () => {
    signInWithPassword.mockResolvedValue({
      error: Object.assign(new Error("Request rate limit reached"), {
        code: "over_request_rate_limit",
        status: 429,
      }),
    });

    render(<LoginScreen />);
    type("runner@example.com", "hunter2");
    fireEvent.click(submitButton());

    await screen.findByText("Too many attempts just now. Wait a moment and try again.");
  });
});
