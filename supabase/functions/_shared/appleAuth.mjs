// Sign in with Apple, server half: the ES256 client secret Apple's token and
// revoke endpoints demand, and reading an identity token's claims. Plain ESM so
// Vitest covers it (src/auth/appleAuthShared.test.ts). docs/release.md.

const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

function pemToPkcs8(pem) {
  const body = String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

// A client secret for `clientId` (the bundle id or the Services ID — each token
// can only be exchanged or revoked under the client it was issued to). Short
// lived on purpose: minted per request, unlike the 6-month one Supabase holds.
export async function appleClientSecret({ teamId, keyId, privateKeyPem, clientId, now = Date.now() }) {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKeyPem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const iat = Math.floor(now / 1000);
  const signingInput =
    `${b64urlJson({ alg: "ES256", kid: keyId })}.` +
    b64urlJson({ iss: teamId, iat, exp: iat + 300, aud: "https://appleid.apple.com", sub: clientId });
  // WebCrypto's ECDSA output is already JWS's raw r||s form.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

// Claims of a JWT we just received from Apple over TLS, so no signature check.
export function jwtClaims(jwt) {
  const part = String(jwt ?? "").split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}
