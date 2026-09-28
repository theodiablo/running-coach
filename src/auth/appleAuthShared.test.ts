import { describe, it, expect } from "vitest";
// @ts-expect-error — plain ESM module shared with the apple-auth edge function.
import { appleClientSecret, jwtClaims } from "../../supabase/functions/_shared/appleAuth.mjs";

async function p8Key() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  // The bare base64 body, wrapped as in a .p8; the armor lines are stripped either way.
  const pem = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  return { pem, publicKey: pair.publicKey };
}

const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

describe("appleClientSecret", () => {
  it("signs an ES256 JWT Apple can verify with the key's public half", async () => {
    const { pem, publicKey } = await p8Key();
    const now = Date.UTC(2026, 8, 28);
    const jwt = await appleClientSecret({ teamId: "TEAM123456", keyId: "KEY1234567", privateKeyPem: pem, clientId: "solutions.camboulive.run", now });
    const [header, payload, sig] = jwt.split(".");

    expect(JSON.parse(new TextDecoder().decode(fromB64url(header)))).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(jwtClaims(jwt)).toEqual({
      iss: "TEAM123456",
      iat: now / 1000,
      exp: now / 1000 + 300,
      aud: "https://appleid.apple.com",
      sub: "solutions.camboulive.run",
    });
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, publicKey, fromB64url(sig), new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(ok).toBe(true);
  });
});

describe("jwtClaims", () => {
  it("reads nothing from a malformed token", () => {
    expect(jwtClaims(undefined)).toBeNull();
    expect(jwtClaims("not-a-jwt")).toBeNull();
    expect(jwtClaims("a.@@@.c")).toBeNull();
  });
});
