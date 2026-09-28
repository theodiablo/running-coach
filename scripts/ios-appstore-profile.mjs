#!/usr/bin/env node
// Create (or refresh) the App Store provisioning profile the iOS release uses,
// and install it on the current machine — no Mac-side Xcode UI needed. Uses the
// SAME App Store Connect API key (.p8) the release workflow already uses.
//
// Why this exists: the release archive is signed for DISTRIBUTION with a
// manually-created Apple Distribution certificate (see scripts/ios-dist-cert.mjs
// and the "Install Apple Distribution certificate" workflow step). Manual
// distribution signing needs an App Store provisioning profile present in the
// keychain search path, and unlike certificates, App Store profiles are NOT
// capped — they can be regenerated freely. Regenerating one on every release is
// cheap and keeps it bound to the current distribution certificate(s), so the
// pipeline never falls back to Xcode's automatic-signing path that mints a fresh
// (throwaway, capped) Apple DEVELOPMENT certificate on each ephemeral CI runner
// — the accumulation that eventually hit "reached the maximum number of
// certificates" and failed the archive.
//
// What it does:
//   1. looks up the app's bundle id resource,
//   2. gathers the team's live Apple Distribution certificate ids,
//   3. deletes any existing profile with the same name (so it always rebinds to
//      the current certs and never collides on the unique-name constraint),
//   4. creates a fresh IOS_APP_STORE profile for that bundle id + certs,
//   5. installs it into ~/Library/MobileDevice/Provisioning Profiles/ so
//      xcodebuild can resolve it by PROVISIONING_PROFILE_SPECIFIER (its name).
//
// Usage (CI passes these as env):
//   ASC_API_KEY_ID, ASC_API_ISSUER_ID, and one of
//   ASC_API_KEY_P8_PATH | ASC_API_KEY_P8_BASE64  (same values as the secrets)
//   BUNDLE_ID       app bundle identifier (default: solutions.camboulive.run)
//   PROFILE_NAME    profile name / specifier (default: "Running Coach App Store CI")
//   WIDGET_BUNDLE_ID / WIDGET_PROFILE_NAME
//                   the Live Activity widget extension's pair (defaults:
//                   solutions.camboulive.run.widgets / "Running Coach Widget
//                   App Store CI"). The widget is an embedded target with its
//                   own bundle id, so the archive needs a SECOND profile; its
//                   bundle id record is auto-registered on ASC if missing
//                   (unlike the app's, which must already exist). Keep the
//                   names in sync with the pbxproj Release configs'
//                   PROVISIONING_PROFILE_SPECIFIER values.
//
// Flags:
//   --dry-run       validate inputs + sign the API JWT, but stop before any API
//                   call. Verifies the local toolchain / credentials plumbing.
//
// Notes:
//   - The ASC key must have the Admin role (same requirement as the release
//     workflow's other cloud-signing operations).
//   - Creating the profile needs at least one live Apple Distribution
//     certificate on the team (scripts/ios-dist-cert.mjs mints it). The profile
//     is bound to ALL of them, so it stays valid across a cert renewal.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const API = "https://api.appstoreconnect.apple.com/v1";
const dryRun = process.argv.includes("--dry-run");

const fail = (msg) => {
  console.error(`\nError: ${msg}`);
  process.exit(1);
};

// --- inputs ---------------------------------------------------------------
const keyId = process.env.ASC_API_KEY_ID;
const issuerId = process.env.ASC_API_ISSUER_ID;
if (!keyId || !issuerId)
  fail("set ASC_API_KEY_ID and ASC_API_ISSUER_ID (same values as the repo secrets).");

const bundleId = process.env.BUNDLE_ID || "solutions.camboulive.run";
const profileName = process.env.PROFILE_NAME || "Running Coach App Store CI";
const widgetBundleId = process.env.WIDGET_BUNDLE_ID || "solutions.camboulive.run.widgets";
const widgetProfileName = process.env.WIDGET_PROFILE_NAME || "Running Coach Widget App Store CI";

let p8;
if (process.env.ASC_API_KEY_P8_PATH) {
  p8 = fs.readFileSync(process.env.ASC_API_KEY_P8_PATH, "utf8");
} else if (process.env.ASC_API_KEY_P8_BASE64) {
  p8 = Buffer.from(process.env.ASC_API_KEY_P8_BASE64, "base64").toString("utf8");
} else {
  fail("set ASC_API_KEY_P8_PATH (path to the AuthKey .p8) or ASC_API_KEY_P8_BASE64.");
}
if (!p8.includes("BEGIN PRIVATE KEY")) fail("the .p8 content does not look like a PEM private key.");

// --- ASC API auth (ES256 JWT, hand-rolled — no deps) -----------------------
const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const now = Math.floor(Date.now() / 1000);
const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
const payload = b64url(
  JSON.stringify({ iss: issuerId, iat: now, exp: now + 600, aud: "appstoreconnect-v1" })
);
let jwt;
try {
  const sig = crypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: crypto.createPrivateKey(p8),
    dsaEncoding: "ieee-p1363",
  });
  jwt = `${header}.${payload}.${b64url(sig)}`;
} catch (e) {
  fail(`could not sign the API JWT with the .p8 (is it the ASC key?): ${e.message}`);
}
console.log("Signed App Store Connect API token.");

if (dryRun) {
  console.log("\n--dry-run: local toolchain OK (JWT signed). Stopping before the API call.");
  process.exit(0);
}

const asc = async (method, route, body) => {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (json.errors ?? [])
      .map((e) => `${e.title}: ${e.detail ?? ""}`)
      .join("; ");
    fail(`App Store Connect API ${method} ${route} → HTTP ${res.status}. ${detail}`);
  }
  return json;
};

// --- 1. gather live distribution certificates (shared by both profiles) -----
const certs = await asc(
  "GET",
  "/certificates?filter[certificateType]=DISTRIBUTION&limit=200"
);
const certIds = (certs.data ?? []).map((c) => c.id);
if (certIds.length === 0)
  fail(
    "no Apple Distribution certificates on this team — mint one with `npm run ios:dist-cert` first."
  );
console.log(`Binding profiles to ${certIds.length} distribution certificate(s).`);

// Resolve a bundle id resource, optionally registering it on ASC when absent.
// The APP id must already exist (a typo should fail loudly, and the App Store
// record hangs off it); the WIDGET id is ours to create — it's just an
// extension identifier with no capabilities.
const resolveBundleId = async (identifier, { registerIfMissing, name }) => {
  const bundle = await asc(
    "GET",
    `/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=200`
  );
  const found = (bundle.data ?? []).find((b) => b.attributes?.identifier === identifier);
  if (found) {
    console.log(`Bundle id '${identifier}' → ${found.id}`);
    return found;
  }
  if (!registerIfMissing)
    fail(
      `no bundle id '${identifier}' registered on this team. Create the App ID in the Developer portal (or check BUNDLE_ID / the ASC key's team).`
    );
  const registered = await asc("POST", "/bundleIds", {
    data: {
      type: "bundleIds",
      attributes: { identifier, name, platform: "IOS" },
    },
  });
  if (!registered.data?.id)
    fail(`could not register bundle id '${identifier}' on App Store Connect.`);
  console.log(`Registered bundle id '${identifier}' → ${registered.data.id}`);
  return registered.data;
};

// Delete-then-create an IOS_APP_STORE profile for one bundle id and install it
// where xcodebuild resolves profiles by PROVISIONING_PROFILE_SPECIFIER.
// Profile names are unique per team; deleting first lets us always rebind to
// the current cert set (e.g. after a yearly cert renewal) without a collision.
const ensureProfile = async (bundleResource, name) => {
  const existing = await asc(
    "GET",
    `/profiles?filter[name]=${encodeURIComponent(name)}&limit=200`
  );
  for (const p of existing.data ?? []) {
    if (p.attributes?.name !== name) continue;
    await asc("DELETE", `/profiles/${p.id}`);
    console.log(`Deleted stale profile '${name}' (${p.id}).`);
  }

  const created = await asc("POST", "/profiles", {
    data: {
      type: "profiles",
      attributes: { name, profileType: "IOS_APP_STORE" },
      relationships: {
        bundleId: { data: { type: "bundleIds", id: bundleResource.id } },
        certificates: { data: certIds.map((id) => ({ type: "certificates", id })) },
      },
    },
  });
  const attrs = created.data?.attributes ?? {};
  const profileContent = attrs.profileContent;
  const uuid = attrs.uuid;
  if (!profileContent || !uuid)
    fail("App Store Connect returned a profile without content/uuid — cannot install it.");
  console.log(`Created profile '${attrs.name}' (uuid ${uuid}, expires ${attrs.expirationDate}).`);

  const dir = path.join(os.homedir(), "Library", "MobileDevice", "Provisioning Profiles");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${uuid}.mobileprovision`);
  fs.writeFileSync(dest, Buffer.from(profileContent, "base64"));
  console.log(`Installed → ${dest}`);
  return uuid;
};

// A profile carries whatever capabilities the App ID has; an entitlement the
// App ID doesn't grant fails the archive much later with a bare "provisioning
// profile doesn't match the entitlements file". Check the ones App/App.entitlements
// claims here, where the message can name the fix.
const REQUIRED_CAPABILITIES = { HEALTHKIT: "HealthKit", APPLE_ID_AUTH: "Sign In with Apple" };
const assertCapabilities = async (bundleResource) => {
  const res = await asc("GET", `/bundleIds/${bundleResource.id}/bundleIdCapabilities?limit=200`);
  const enabled = new Set((res.data ?? []).map((c) => c.attributes?.capabilityType));
  const missing = Object.entries(REQUIRED_CAPABILITIES).filter(([type]) => !enabled.has(type));
  if (missing.length)
    fail(
      `App ID '${bundleId}' is missing ${missing.map(([, label]) => label).join(", ")}. ` +
        "Enable it in the Developer portal (Identifiers → the App ID → Capabilities), then re-run."
    );
  console.log(`App ID capabilities present: ${Object.values(REQUIRED_CAPABILITIES).join(", ")}.`);
};

const appBundle = await resolveBundleId(bundleId, { registerIfMissing: false });
await assertCapabilities(appBundle);
const appUuid = await ensureProfile(appBundle, profileName);

const widgetBundle = await resolveBundleId(widgetBundleId, {
  registerIfMissing: true,
  name: "Running Coach Live Activity Widget",
});
await ensureProfile(widgetBundle, widgetProfileName);

// Hand the app specifier back to the workflow when running in Actions.
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `name=${profileName}\nuuid=${appUuid}\n`);
}
console.log(`\nPROVISIONING_PROFILE_SPECIFIER (app)    = ${profileName}`);
console.log(`PROVISIONING_PROFILE_SPECIFIER (widget) = ${widgetProfileName}`);
