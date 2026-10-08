#!/usr/bin/env node
// Promote an already-uploaded Android build from one Google Play track to
// another (internal -> production by default) through the Play Developer API.
// No rebuild and no re-upload: the same versionCode Play already processed is
// re-pointed at the target track, release notes carried over. See
// docs/release.md ("Promoting an Android build").
//
// Env:
//   PLAY_SERVICE_ACCOUNT_JSON  service-account JSON key (same secret as the upload)
//   PACKAGE_NAME               default solutions.camboulive.run
//   FROM_TRACK / TO_TRACK      default internal / production
//   VERSION_CODE               optional; default = newest completed release on FROM_TRACK
//   ROLLOUT_PERCENT            1-100, default 100 (< 100 = staged rollout)
//   DRAFT                      "true" = create a draft release to finish in Play Console
//   DRY_RUN                    "true" = validate the edit, then discard it

import crypto from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";

const maxCode = (r) => Math.max(...(r.versionCodes ?? []).map(Number));

/** The source-track release to promote: the one carrying `versionCode`, else the newest completed one. */
export function pickRelease(sourceTrack, versionCode) {
  const releases = (sourceTrack?.releases ?? []).filter((r) => r.versionCodes?.length);
  if (versionCode) {
    const hit = releases.find((r) => r.versionCodes.map(String).includes(String(versionCode)));
    if (!hit) throw new Error(`versionCode ${versionCode} is not on the ${sourceTrack?.track ?? "source"} track.`);
    return hit;
  }
  const completed = releases.filter((r) => r.status === "completed");
  if (!completed.length) throw new Error(`No completed release on the ${sourceTrack?.track ?? "source"} track to promote.`);
  return completed.reduce((a, b) => (maxCode(b) > maxCode(a) ? b : a));
}

/**
 * The target track's new `releases` list. A completed release supersedes
 * everything; a staged rollout keeps the current completed release, which
 * keeps serving the users outside the rollout fraction.
 */
export function promotedReleases(release, targetTrack, { rolloutPercent = 100, draft = false } = {}) {
  const pct = Number(rolloutPercent);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new Error(`Rollout percent must be in (0, 100], got '${rolloutPercent}'.`);
  const next = { versionCodes: release.versionCodes.map(String) };
  if (release.name) next.name = release.name;
  if (release.releaseNotes?.length) next.releaseNotes = release.releaseNotes;
  if (draft) next.status = "draft";
  else if (pct < 100) Object.assign(next, { status: "inProgress", userFraction: pct / 100 });
  else next.status = "completed";
  if (next.status !== "inProgress") return [next];
  const codes = new Set(next.versionCodes);
  const live = (targetTrack?.releases ?? []).find(
    (r) => r.status === "completed" && !r.versionCodes?.some((c) => codes.has(String(c))),
  );
  return live ? [live, next] : [next];
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

async function accessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const aud = key.token_uri || "https://oauth2.googleapis.com/token";
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud, iat: now, exp: now + 3600 }));
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${claims}`), key.private_key);
  const res = await fetch(aud, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${head}.${claims}.${b64url(sig)}`,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`OAuth token request failed (${res.status}): ${JSON.stringify(body)}`);
  return body.access_token;
}

async function main(env) {
  const key = JSON.parse(env.PLAY_SERVICE_ACCOUNT_JSON || "{}");
  if (!key.client_email || !key.private_key) throw new Error("PLAY_SERVICE_ACCOUNT_JSON is missing or not a service-account key.");
  const pkg = env.PACKAGE_NAME || "solutions.camboulive.run";
  const from = env.FROM_TRACK || "internal";
  const to = env.TO_TRACK || "production";
  if (from === to) throw new Error(`Source and target track are both '${from}'.`);
  const dryRun = env.DRY_RUN === "true";

  const token = await accessToken(key);
  const call = async (method, path, body) => {
    const res = await fetch(`${API}/${pkg}/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
    return text ? JSON.parse(text) : {};
  };

  const { id: edit } = await call("POST", "edits");
  try {
    const source = await call("GET", `edits/${edit}/tracks/${from}`);
    const target = await call("GET", `edits/${edit}/tracks/${to}`).catch(() => ({ track: to, releases: [] }));
    const release = pickRelease(source, env.VERSION_CODE?.trim());
    const releases = promotedReleases(release, target, {
      rolloutPercent: env.ROLLOUT_PERCENT?.trim() || 100,
      draft: env.DRAFT === "true",
    });
    console.log(`Promoting ${release.name ?? "(unnamed)"} [${release.versionCodes.join(", ")}] ${from} -> ${to}`);
    console.log(JSON.stringify(releases, null, 2));
    await call("PUT", `edits/${edit}/tracks/${to}`, { track: to, releases });
    if (dryRun) {
      await call("POST", `edits/${edit}:validate`);
      console.log("Dry run: edit validated, not committed.");
      await call("DELETE", `edits/${edit}`);
      return;
    }
    await call("POST", `edits/${edit}:commit`);
    console.log(`Committed. ${to} now carries versionCode ${release.versionCodes.join(", ")}.`);
  } catch (err) {
    await call("DELETE", `edits/${edit}`).catch(() => {});
    throw err;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.env).catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
