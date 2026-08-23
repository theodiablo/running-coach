import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const { signUp, signInWithPassword, signInWithOAuth } = vi.hoisted(() => ({
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  signInWithOAuth: vi.fn(),
}));
vi.mock("./supabase", () => ({
  supabase: { auth: { signUp, signInWithPassword, signInWithOAuth } },
  authRedirectTo: () => "http://localhost/",
}));
vi.mock("./native", () => ({ isNative: false, isAndroid: false }));

import LoginScreen from "./LoginScreen";

// The tabs and the submit button share their labels in signin mode, so the
// form's own button is addressed by role within the form, not by name.
const submitButton = () => document.querySelector("form button[type=submit]") as HTMLButtonElement;

const fillAndSubmit = (email = "runner@example.com") => {
  fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
  fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: email } });
  fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: "correct horse battery" } });
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
};

beforeEach(() => {
  vi.clearAllMocks();
  signUp.mockResolvedValue({ error: null });
});

describe("LoginScreen sign-up", () => {
  it("replaces the form with where the link went, leaving nothing to press again", async () => {
    // The regression: a one-line "check your email" note under a live Create
    // account button. One user pressed it six more times and collected a 429
    // each time, ending on "email rate limit exceeded".
    render(<LoginScreen />);
    fillAndSubmit();

    await screen.findByText("Check your inbox");
    expect(screen.getByText(/runner@example\.com/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create account" })).not.toBeInTheDocument();
  });

  it("keeps Sign in one tap away once the link is confirmed", async () => {
    render(<LoginScreen />);
    fillAndSubmit();
    await screen.findByText("Check your inbox");

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.queryByText("Check your inbox")).not.toBeInTheDocument();
    expect(submitButton()).toHaveTextContent("Sign in");
  });

  it("offers a way back to fix a typo'd address", async () => {
    render(<LoginScreen />);
    fillAndSubmit("typo@exmaple.com");
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

    render(<LoginScreen />);
    fillAndSubmit();

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

    render(<LoginScreen />);
    fillAndSubmit();

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

    render(<LoginScreen />);
    fillAndSubmit();

    expect(await screen.findByText(/couldn't send that email/)).toHaveClass("text-red-400");
  });

  it("keeps the server's own message when nothing maps", async () => {
    signUp.mockResolvedValue({
      error: Object.assign(new Error("Signups not allowed for this instance"), {
        code: "signup_disabled",
        status: 422,
      }),
    });

    render(<LoginScreen />);
    fillAndSubmit();

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
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "runner@example.com" } });
    fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: "hunter2" } });
    fireEvent.click(submitButton());

    await screen.findByText("Too many attempts just now. Wait a moment and try again.");
  });
});
