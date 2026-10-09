#!/usr/bin/env node
// Promote an iOS build App Store Connect already has (uploaded by release.yml)
// to TestFlight testers or to App Store review, through the ASC API. No
// rebuild and no re-upload; waits for Apple to finish processing the build
// first. See docs/release.md ("Promoting an iOS build").
//
// Env:
//   ASC_API_KEY_P8_BASE64 / ASC_API_KEY_ID / ASC_API_ISSUER_ID  same key as the upload
//   BUNDLE_ID          default solutions.camboulive.run
//   TARGET             "testflight" (default) | "production"
//   VERSION            optional marketing version (1.5.0); default = newest upload
//   BUILD_NUMBER       optional CFBundleVersion; default = newest of that version
//   WAIT_MINUTES       how long to wait for the build to appear/process, default 60
//   GROUPS             testflight: comma-separated beta group names; default = every external group
//   RELEASE_NOTES      optional "What to Test" / "What's New" ("|" = line break)
//   NOTES_LOCALE       testflight "What to Test" locale, default en-US
//   RELEASE_TYPE       production: "after_approval" (default) | "manual"
//   PHASED_RELEASE     production: "true" = 7-day phased release
//   DRAFT              production: "true" = prepare the version, don't submit it
//   DRY_RUN            "true" = resolve and print the plan, change nothing

import crypto from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.appstoreconnect.apple.com/v1";

const EDITABLE = new Set(["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"]);
const RELEASED = new Set(["READY_FOR_SALE", "READY_FOR_DISTRIBUTION", "REMOVED_FROM_SALE", "DEVELOPER_REMOVED_FROM_SALE", "REPLACED_WITH_NEW_VERSION"]);
const NOTES_MAX = 4000;

/** Builds from a `GET /builds?include=preReleaseVersion` page, flattened. */
export function normalizeBuilds(page) {
  const pre = new Map((page.included ?? []).filter((i) => i.type === "preReleaseVersions").map((i) => [i.id, i.attributes]));
  return (page.data ?? []).map((b) => ({
    id: b.id,
    build: b.attributes.version,
    version: pre.get(b.relationships?.preReleaseVersion?.data?.id)?.version,
    uploadedDate: b.attributes.uploadedDate,
    processingState: b.attributes.processingState,
    expired: !!b.attributes.expired,
  }));
}

/** The build to promote: newest unexpired upload matching the optional version/build number. */
export function pickBuild(builds, { version, build } = {}) {
  const hits = builds.filter(
    (b) => !b.expired && (!version || b.version === version) && (!build || String(b.build) === String(build)),
  );
  return hits.reduce((a, b) => (!a || Date.parse(b.uploadedDate) > Date.parse(a.uploadedDate) ? b : a), undefined);
}

/** The beta groups to add the build to: the named ones, else every external group. */
export function pickGroups(groups, names) {
  const wanted = (names ?? "").split(",").map((n) => n.trim()).filter(Boolean);
  if (!wanted.length) {
    const external = groups.filter((g) => !g.isInternalGroup);
    if (!external.length) throw new Error("No external TestFlight group exists; create one in App Store Connect or name a group.");
    return external;
  }
  return wanted.map((n) => {
    const hit = groups.find((g) => g.name.toLowerCase() === n.toLowerCase());
    if (!hit) throw new Error(`No TestFlight group named '${n}' (have: ${groups.map((g) => g.name).join(", ") || "none"}).`);
    return hit;
  });
}

const stateOf = (v) => v.appVersionState ?? v.appStoreState;

/**
 * What to do with the app's App Store versions to ship `versionString`:
 * reuse it, rename the one editable version, or create it. Apple allows one
 * version in flight at a time, so anything else already in flight refuses.
 */
export function planAppStoreVersion(versions, versionString, buildId) {
  const same = versions.find((v) => v.versionString === versionString);
  if (same) {
    const state = stateOf(same);
    if (EDITABLE.has(state)) return { action: "reuse", version: same };
    if (same.buildId === buildId && !RELEASED.has(state)) return { action: "submitted", version: same };
    throw new Error(`App Store version ${versionString} is already ${state}; ship a new version instead.`);
  }
  const editable = versions.find((v) => EDITABLE.has(stateOf(v)));
  if (editable) return { action: "rename", version: editable };
  const inFlight = versions.find((v) => !RELEASED.has(stateOf(v)));
  if (inFlight) {
    throw new Error(`App Store version ${inFlight.versionString} is ${stateOf(inFlight)}; release or remove it before submitting ${versionString}.`);
  }
  return { action: "create" };
}

export const hasReleased = (versions) => versions.some((v) => RELEASED.has(stateOf(v)));

/** Notes typed into a dispatch form: a single line, so "\n" and "|" stand for line breaks. */
export function notesFromInput(text) {
  const body = (text ?? "").replace(/\\n|\|/g, "\n").split("\n").map((l) => l.trim()).join("\n").trim();
  if (!body) return undefined;
  if (body.length > NOTES_MAX) throw new Error(`Release notes are ${body.length} characters; Apple allows ${NOTES_MAX}.`);
  return body;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function tokenFactory({ keyId, issuerId, p8 }) {
  const key = crypto.createPrivateKey(p8);
  return () => {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
    const claims = b64url(JSON.stringify({ iss: issuerId, iat: now, exp: now + 600, aud: "appstoreconnect-v1" }));
    const sig = crypto.sign("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
    return `${head}.${claims}.${b64url(sig)}`;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(env) {
  const p8 = Buffer.from(env.ASC_API_KEY_P8_BASE64 || "", "base64").toString("utf8");
  if (!env.ASC_API_KEY_ID || !env.ASC_API_ISSUER_ID || !p8.includes("BEGIN PRIVATE KEY")) {
    throw new Error("ASC_API_KEY_P8_BASE64 / ASC_API_KEY_ID / ASC_API_ISSUER_ID are not all set.");
  }
  const target = env.TARGET || "testflight";
  if (!["testflight", "production"].includes(target)) throw new Error(`Unknown target '${target}'.`);
  const dryRun = env.DRY_RUN === "true";
  const draft = env.DRAFT === "true";
  const notes = notesFromInput(env.RELEASE_NOTES);
  const bundleId = env.BUNDLE_ID || "solutions.camboulive.run";
  const version = env.VERSION?.trim().replace(/^v/, "") || undefined;
  const buildNumber = env.BUILD_NUMBER?.trim() || undefined;
  const waitMin = Number(env.WAIT_MINUTES?.trim() || 60);
  if (!Number.isFinite(waitMin) || waitMin < 0) throw new Error(`wait_minutes must be a number of minutes, got '${env.WAIT_MINUTES}'.`);

  const token = tokenFactory({ keyId: env.ASC_API_KEY_ID, issuerId: env.ASC_API_ISSUER_ID, p8 });
  const call = async (method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token()}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      const errs = (() => { try { return JSON.parse(text).errors ?? []; } catch { return []; } })();
      const detail = errs.map((e) => `${e.title}: ${e.detail ?? ""}`).join("; ") || text;
      throw new Error(`${method} ${path} failed (${res.status}): ${detail}`);
    }
    return text ? JSON.parse(text) : {};
  };
  const write = async (what, method, path, body) => {
    console.log(`${dryRun ? "[dry run] would " : ""}${what}`);
    return dryRun ? { data: {} } : call(method, path, body);
  };

  const apps = await call("GET", `/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`);
  const app = (apps.data ?? []).find((a) => a.attributes.bundleId === bundleId);
  if (!app) throw new Error(`No App Store Connect app with bundle id ${bundleId}.`);

  const query = new URLSearchParams({
    "filter[app]": app.id,
    "filter[expired]": "false",
    "filter[preReleaseVersion.platform]": "IOS",
    sort: "-uploadedDate",
    include: "preReleaseVersion",
    limit: "50",
  });
  if (version) query.set("filter[preReleaseVersion.version]", version);
  if (buildNumber) query.set("filter[version]", buildNumber);
  const wanted = [version, buildNumber && `(${buildNumber})`].filter(Boolean).join(" ") || "the newest build";

  const deadline = Date.now() + waitMin * 60_000;
  let build;
  for (;;) {
    build = pickBuild(normalizeBuilds(await call("GET", `/builds?${query}`)), { version, build: buildNumber });
    if (build?.processingState === "VALID") break;
    if (build && build.processingState !== "PROCESSING") {
      throw new Error(`Build ${build.version} (${build.build}) is ${build.processingState}; Apple won't distribute it.`);
    }
    if (Date.now() > deadline) {
      throw new Error(build ? `Build ${build.version} (${build.build}) is still processing after ${waitMin} min.` : `${wanted} hasn't reached App Store Connect after ${waitMin} min.`);
    }
    console.log(build ? `Build ${build.version} (${build.build}) is processing; waiting...` : `Waiting for ${wanted} to reach App Store Connect...`);
    await sleep(60_000);
  }
  console.log(`Promoting build ${build.version} (${build.build}) to ${target}.`);

  if (target === "testflight") {
    const groupsPage = await call("GET", `/apps/${app.id}/betaGroups?limit=200`);
    const groups = pickGroups((groupsPage.data ?? []).map((g) => ({ id: g.id, ...g.attributes })), env.GROUPS);

    if (notes) {
      const locale = env.NOTES_LOCALE?.trim() || "en-US";
      const locs = await call("GET", `/builds/${build.id}/betaBuildLocalizations`);
      const loc = (locs.data ?? []).find((l) => l.attributes.locale === locale);
      if (loc) {
        await write(`set What to Test (${locale})`, "PATCH", `/betaBuildLocalizations/${loc.id}`, {
          data: { type: "betaBuildLocalizations", id: loc.id, attributes: { whatsNew: notes } },
        });
      } else {
        await write(`add What to Test (${locale})`, "POST", "/betaBuildLocalizations", {
          data: {
            type: "betaBuildLocalizations",
            attributes: { locale, whatsNew: notes },
            relationships: { build: { data: { type: "builds", id: build.id } } },
          },
        });
      }
    }

    for (const g of groups) {
      if (g.isInternalGroup && g.hasAccessToAllBuilds) {
        console.log(`${g.name}: internal group already gets every build.`);
        continue;
      }
      await write(`add the build to ${g.name}`, "POST", `/betaGroups/${g.id}/relationships/builds`, {
        data: [{ type: "builds", id: build.id }],
      });
    }

    if (groups.some((g) => !g.isInternalGroup)) {
      const existing = await call("GET", `/builds/${build.id}/betaAppReviewSubmission`).catch(() => ({ data: null }));
      if (existing.data) {
        console.log(`Beta App Review: already ${existing.data.attributes.betaReviewState}.`);
      } else {
        await write("submit the build for Beta App Review", "POST", "/betaAppReviewSubmissions", {
          data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id: build.id } } } },
        });
      }
    }
    console.log(dryRun ? "Dry run: nothing changed." : `Done. Testers in ${groups.map((g) => g.name).join(", ")} get it once any beta review clears.`);
    return;
  }

  const versionsPage = await call("GET", `/apps/${app.id}/appStoreVersions?filter[platform]=IOS&include=build&limit=200`);
  const versions = (versionsPage.data ?? []).map((v) => ({ id: v.id, buildId: v.relationships?.build?.data?.id, ...v.attributes }));
  const plan = planAppStoreVersion(versions, build.version, build.id);
  if (plan.action === "submitted") {
    console.log(`App Store version ${build.version} already carries this build and is ${stateOf(plan.version)}; nothing to do.`);
    return;
  }
  const releaseType = env.RELEASE_TYPE === "manual" ? "MANUAL" : "AFTER_APPROVAL";

  let asv;
  if (plan.action === "create") {
    asv = (await write(`create App Store version ${build.version}`, "POST", "/appStoreVersions", {
      data: {
        type: "appStoreVersions",
        attributes: { platform: "IOS", versionString: build.version, releaseType },
        relationships: { app: { data: { type: "apps", id: app.id } } },
      },
    })).data;
  } else {
    asv = plan.version;
    const what = plan.action === "rename" ? `rename editable version ${asv.versionString} to ${build.version}` : `update App Store version ${build.version}`;
    await write(`${what} (release ${releaseType})`, "PATCH", `/appStoreVersions/${asv.id}`, {
      data: { type: "appStoreVersions", id: asv.id, attributes: { versionString: build.version, releaseType } },
    });
  }
  if (dryRun && !asv.id) {
    console.log("[dry run] would attach the build, set What's New and submit for review. Nothing changed.");
    return;
  }

  await write("attach the build", "PATCH", `/appStoreVersions/${asv.id}/relationships/build`, {
    data: { type: "builds", id: build.id },
  });

  const firstRelease = !hasReleased(versions);
  const locs = (await call("GET", `/appStoreVersions/${asv.id}/appStoreVersionLocalizations?limit=200`)).data ?? [];
  if (notes && firstRelease) console.log("::warning::First App Store release: Apple takes no What's New, so the notes were ignored.");
  if (notes && !firstRelease) {
    for (const l of locs) {
      await write(`set What's New (${l.attributes.locale})`, "PATCH", `/appStoreVersionLocalizations/${l.id}`, {
        data: { type: "appStoreVersionLocalizations", id: l.id, attributes: { whatsNew: notes } },
      });
    }
  }
  const missing = notes || firstRelease ? [] : locs.filter((l) => !l.attributes.whatsNew?.trim()).map((l) => l.attributes.locale);

  const phased = await call("GET", `/appStoreVersions/${asv.id}/appStoreVersionPhasedRelease`).catch(() => ({ data: null }));
  if (env.PHASED_RELEASE === "true" && !phased.data) {
    await write("enable phased release", "POST", "/appStoreVersionPhasedReleases", {
      data: {
        type: "appStoreVersionPhasedReleases",
        attributes: { phasedReleaseState: "INACTIVE" },
        relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: asv.id } } },
      },
    });
  } else if (env.PHASED_RELEASE !== "true" && phased.data) {
    await write("disable phased release", "DELETE", `/appStoreVersionPhasedReleases/${phased.data.id}`);
  }

  if (draft) {
    if (missing.length) console.log(`::warning::What's New is empty for ${missing.join(", ")}; fill it in before submitting.`);
    console.log(`Draft: version ${build.version} is prepared with build ${build.build}; submit it from App Store Connect.`);
    return;
  }
  if (missing.length) {
    throw new Error(`What's New is empty for ${missing.join(", ")}. Re-run with release_notes, or fill it in App Store Connect. The version is prepared with the build attached.`);
  }

  const open = await call("GET", `/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW`);
  let submission = open.data?.[0];
  if (!submission) {
    submission = (await write("open a review submission", "POST", "/reviewSubmissions", {
      data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: { data: { type: "apps", id: app.id } } } },
    })).data;
  }
  const items = submission.id ? (await call("GET", `/reviewSubmissions/${submission.id}/items?include=appStoreVersion`)).data ?? [] : [];
  if (!items.some((i) => i.relationships?.appStoreVersion?.data?.id === asv.id)) {
    await write("add the version to the review submission", "POST", "/reviewSubmissionItems", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: { data: { type: "reviewSubmissions", id: submission.id } },
          appStoreVersion: { data: { type: "appStoreVersions", id: asv.id } },
        },
      },
    });
  }
  await write("submit for App Review", "PATCH", `/reviewSubmissions/${submission.id}`, {
    data: { type: "reviewSubmissions", id: submission.id, attributes: { submitted: true } },
  });
  console.log(dryRun ? "Dry run: nothing changed." : `Submitted ${build.version} (${build.build}) for App Review, release ${releaseType}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.env).catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
