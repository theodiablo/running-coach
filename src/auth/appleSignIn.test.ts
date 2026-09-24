import { describe, it, expect, vi, beforeEach } from "vitest";

const signInWithIdToken = vi.fn();
const signInWithOAuth = vi.fn();
const authorize = vi.fn();
const browserOpen = vi.fn();
const isPluginAvailable = vi.fn();

type Env = { isNative?: boolean; isIos?: boolean; isAndroid?: boolean };

// isNative/isIos are module-level consts, so each case loads the seam fresh
// against the platform it is about.
async function load({ isNative = true, isIos = true, isAndroid = false }: Env = {}) {
  vi.resetModules();
  vi.doMock("@capacitor/core", () => ({ Capacitor: { isPluginAvailable } }));
  vi.doMock("@capacitor/browser", () => ({ Browser: { open: browserOpen } }));
  vi.doMock("../native", () => ({ isNative, isIos, isAndroid }));
  vi.doMock("../supabase", () => ({
    supabase: { auth: { signInWithIdToken, signInWithOAuth } },
    authRedirectTo: () => "http://localhost/",
    AUTH_DEEP_LINK: "solutions.camboulive.run://auth-callback",
    NATIVE_BUNDLE_ID: "solutions.camboulive.run",
  }));
  vi.doMock("@capacitor-community/apple-sign-in", () => ({ SignInWithApple: { authorize } }));
  return (await import("./appleSignIn")).signInWithApple;
}

beforeEach(() => {
  vi.clearAllMocks();
  isPluginAvailable.mockReturnValue(true);
  signInWithIdToken.mockResolvedValue({ error: null });
  signInWithOAuth.mockResolvedValue({ data: { url: "https://appleid.apple.com/auth" }, error: null });
  authorize.mockResolvedValue({ response: { identityToken: "id-token", authorizationCode: "c" } });
});

describe("signInWithApple — native iOS", () => {
  it("hands Apple the nonce HASH and Supabase the raw one", async () => {
    const signIn = await load();
    expect(await signIn()).toBe("signed-in");

    const sentToApple = authorize.mock.calls[0][0].nonce as string;
    const sentToSupabase = signInWithIdToken.mock.calls[0][0].nonce as string;
    // Both are hex, and the raw value must never be what Apple was given:
    // Supabase hashes the raw one to compare against the token's claim.
    expect(sentToApple).toMatch(/^[0-9a-f]{64}$/);
    expect(sentToSupabase).toMatch(/^[0-9a-f]{64}$/);
    expect(sentToSupabase).not.toBe(sentToApple);

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sentToSupabase));
    const hashed = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    expect(hashed).toBe(sentToApple);

    expect(signInWithIdToken).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "apple", token: "id-token" }),
    );
    expect(signInWithOAuth).not.toHaveBeenCalled();
  });

  it("reports a dismissed sheet as cancelled, not an error", async () => {
    authorize.mockRejectedValue(
      new Error("The operation couldn’t be completed. (com.apple.AuthenticationServices.AuthorizationError error 1001.)"),
    );
    const signIn = await load();
    expect(await signIn()).toBe("cancelled");
    expect(signInWithIdToken).not.toHaveBeenCalled();
  });

  it("throws a real authorization failure for the caller to show", async () => {
    authorize.mockRejectedValue(new Error("authorization attempt failed"));
    const signIn = await load();
    await expect(signIn()).rejects.toThrow("authorization attempt failed");
  });

  it("falls back to the browser flow when the shell has no plugin", async () => {
    isPluginAvailable.mockReturnValue(false);
    const signIn = await load();
    expect(await signIn()).toBe("redirecting");
    expect(authorize).not.toHaveBeenCalled();
    expect(signInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "apple" }),
    );
    expect(browserOpen).toHaveBeenCalledWith({ url: "https://appleid.apple.com/auth" });
  });
});

describe("signInWithApple — browser flow", () => {
  it("redirects the page itself on the web", async () => {
    const signIn = await load({ isNative: false, isIos: false });
    expect(await signIn()).toBe("redirecting");
    expect(authorize).not.toHaveBeenCalled();
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "apple",
      options: { redirectTo: "http://localhost/", skipBrowserRedirect: false },
    });
    expect(browserOpen).not.toHaveBeenCalled();
  });

  it("navigates rather than opening a Custom Tab on Android", async () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ assign } as unknown as Location);
    const signIn = await load({ isNative: true, isIos: false, isAndroid: true });
    expect(await signIn()).toBe("redirecting");
    expect(assign).toHaveBeenCalledWith("https://appleid.apple.com/auth");
    expect(browserOpen).not.toHaveBeenCalled();
  });

  it("throws the provider error instead of pretending it redirected", async () => {
    signInWithOAuth.mockResolvedValue({ data: null, error: new Error("provider disabled") });
    const signIn = await load({ isNative: false, isIos: false });
    await expect(signIn()).rejects.toThrow("provider disabled");
  });
});
