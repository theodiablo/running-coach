import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "@supabase/supabase-js";

const signInWithIdToken = vi.fn();
const invoke = vi.fn();
const authorize = vi.fn();
const isPluginAvailable = vi.fn();

type Env = { isNative?: boolean; isIos?: boolean };

// isNative/isIos are module-level consts, so each case loads the seam fresh
// against the platform it is about.
async function load({ isNative = true, isIos = true }: Env = {}) {
  vi.resetModules();
  vi.doMock("@capacitor/core", () => ({ Capacitor: { isPluginAvailable } }));
  vi.doMock("../native", () => ({ isNative, isIos }));
  vi.doMock("../supabase", () => ({
    supabase: { auth: { signInWithIdToken }, functions: { invoke } },
    AUTH_DEEP_LINK: "solutions.camboulive.run://auth-callback",
    NATIVE_BUNDLE_ID: "solutions.camboulive.run",
  }));
  vi.doMock("@capacitor-community/apple-sign-in", () => ({ SignInWithApple: { authorize } }));
  return await import("./appleSignIn");
}

const session = (providers: string[], providerRefreshToken?: string) => ({
  provider_refresh_token: providerRefreshToken,
  user: { identities: providers.map(provider => ({ provider })) },
} as unknown as Session);

beforeEach(() => {
  vi.clearAllMocks();
  isPluginAvailable.mockReturnValue(true);
  signInWithIdToken.mockResolvedValue({ error: null });
  invoke.mockResolvedValue({ data: {}, error: null });
  authorize.mockResolvedValue({ response: { identityToken: "id-token", authorizationCode: "auth-code" } });
});

describe("nativeAppleSignIn", () => {
  it("hands Apple the nonce HASH and Supabase the raw one", async () => {
    const { nativeAppleSignIn } = await load();
    expect(await nativeAppleSignIn()).toBe("signed-in");

    const sentToApple = authorize.mock.calls[0][0].nonce as string;
    const sentToSupabase = signInWithIdToken.mock.calls[0][0].nonce as string;
    expect(sentToApple).toMatch(/^[0-9a-f]{64}$/);
    expect(sentToSupabase).not.toBe(sentToApple);

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sentToSupabase));
    const hashed = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    expect(hashed).toBe(sentToApple);
    expect(signInWithIdToken).toHaveBeenCalledWith(expect.objectContaining({ provider: "apple", token: "id-token" }));
  });

  it("hands the authorization code to the server so deletion can revoke it", async () => {
    const { nativeAppleSignIn } = await load();
    await nativeAppleSignIn();
    expect(invoke).toHaveBeenCalledWith("apple-auth", { body: { action: "store", authorizationCode: "auth-code" } });
  });

  it("still signs in when storing the grant fails", async () => {
    invoke.mockRejectedValue(new Error("offline"));
    const { nativeAppleSignIn } = await load();
    expect(await nativeAppleSignIn()).toBe("signed-in");
  });

  it("reports a dismissed sheet as cancelled, not an error", async () => {
    authorize.mockRejectedValue(
      new Error("The operation couldn’t be completed. (com.apple.AuthenticationServices.AuthorizationError error 1001.)"),
    );
    const { nativeAppleSignIn } = await load();
    expect(await nativeAppleSignIn()).toBe("cancelled");
    expect(signInWithIdToken).not.toHaveBeenCalled();
  });

  it("throws a real authorization failure for the caller to show", async () => {
    authorize.mockRejectedValue(new Error("authorization attempt failed"));
    const { nativeAppleSignIn } = await load();
    await expect(nativeAppleSignIn()).rejects.toThrow("authorization attempt failed");
  });

  it("throws a Supabase rejection of the identity token", async () => {
    signInWithIdToken.mockResolvedValue({ error: new Error("invalid nonce") });
    const { nativeAppleSignIn } = await load();
    await expect(nativeAppleSignIn()).rejects.toThrow("invalid nonce");
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["the web", { isNative: false, isIos: false }],
    ["Android", { isNative: true, isIos: false }],
  ])("leaves %s to the browser flow", async (_label, env) => {
    const { nativeAppleSignIn } = await load(env);
    expect(await nativeAppleSignIn()).toBeNull();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("leaves a shell without the plugin to the browser flow", async () => {
    isPluginAvailable.mockReturnValue(false);
    const { nativeAppleSignIn } = await load();
    expect(await nativeAppleSignIn()).toBeNull();
  });
});

describe("rememberAppleGrant", () => {
  it("sends the browser flow's Apple refresh token once", async () => {
    const { rememberAppleGrant } = await load({ isNative: false, isIos: false });
    rememberAppleGrant(session(["apple"], "rt-1"));
    rememberAppleGrant(session(["apple"], "rt-1"));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("apple-auth", { body: { action: "store", refreshToken: "rt-1" } });
  });

  it("ignores sessions without an Apple identity or a provider refresh token", async () => {
    const { rememberAppleGrant } = await load({ isNative: false, isIos: false });
    rememberAppleGrant(session(["google"], "google-rt"));
    rememberAppleGrant(session(["apple"]));
    rememberAppleGrant(null);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("revokeAppleGrants", () => {
  it("revokes for an account with an Apple identity", async () => {
    const { revokeAppleGrants } = await load();
    await revokeAppleGrants(session(["email", "apple"]));
    expect(invoke).toHaveBeenCalledWith("apple-auth", { body: { action: "revoke" } });
  });

  it("skips accounts that never used Apple", async () => {
    const { revokeAppleGrants } = await load();
    await revokeAppleGrants(session(["google"]));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("never throws, so deletion always goes ahead", async () => {
    invoke.mockRejectedValue(new Error("offline"));
    const { revokeAppleGrants } = await load();
    await expect(revokeAppleGrants(session(["apple"]))).resolves.toBeUndefined();
  });
});
