import { describe, it, expect } from "vitest";
import { offlineSessionFromRaw, supabaseStorageKey, OFFLINE_SESSION_MAX_AGE_MS } from "./offlineSession";

const NOW = 1_800_000_000_000;
const sess = (expiresAtMs: number, extra: Record<string, unknown> = {}) => JSON.stringify({
  access_token: "at",
  refresh_token: "rt",
  expires_at: Math.floor(expiresAtMs / 1000),
  user: { id: "u1" },
  ...extra,
});

describe("offlineSessionFromRaw", () => {
  it("accepts a still-valid session", () => {
    const s = offlineSessionFromRaw(sess(NOW + 60_000), NOW);
    expect(s?.user.id).toBe("u1");
  });

  it("accepts a session whose token expired within the window", () => {
    const s = offlineSessionFromRaw(sess(NOW - 2 * 24 * 60 * 60 * 1000), NOW);
    expect(s?.user.id).toBe("u1");
  });

  it("rejects a session idle for longer than the window", () => {
    expect(offlineSessionFromRaw(sess(NOW - OFFLINE_SESSION_MAX_AGE_MS - 1000), NOW)).toBeNull();
  });

  it("rejects empty storage, junk, and shapes without a user or refresh token", () => {
    expect(offlineSessionFromRaw(null, NOW)).toBeNull();
    expect(offlineSessionFromRaw("not json", NOW)).toBeNull();
    expect(offlineSessionFromRaw(JSON.stringify({ expires_at: NOW / 1000 }), NOW)).toBeNull();
    expect(offlineSessionFromRaw(sess(NOW, { refresh_token: undefined }), NOW)).toBeNull();
    expect(offlineSessionFromRaw(sess(NOW, { user: {} }), NOW)).toBeNull();
    expect(offlineSessionFromRaw(sess(NOW, { expires_at: undefined }), NOW)).toBeNull();
  });
});

describe("supabaseStorageKey", () => {
  it("derives sb-<ref>-auth-token from the project URL", () => {
    expect(supabaseStorageKey("https://abcdefgh.supabase.co")).toBe("sb-abcdefgh-auth-token");
    expect(supabaseStorageKey("http://127.0.0.1:54321")).toBe("sb-127-auth-token");
  });
});
