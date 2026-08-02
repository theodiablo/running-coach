import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import viteConfig from "../vite.config";

// WKWebView's JS engine IS the OS version, so the shell on iOS 15 runs a
// Safari 15 engine. If Vite's build target outruns IPHONEOS_DEPLOYMENT_TARGET
// the bundler is free to emit syntax the oldest supported iPhone cannot parse —
// which is fatal for the whole chunk, not just the feature using it. Vite's
// default (`baseline-widely-available`) resolves to ios16.4 and did exactly
// that, so the target is pinned explicitly; this keeps the two from drifting
// apart again, in either direction.

const pbxproj = readFileSync("ios/App/App.xcodeproj/project.pbxproj", "utf8");

const deploymentTarget = Math.min(
  ...[...pbxproj.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)].map(m => parseFloat(m[1])),
);

const target = viteConfig.build?.target;
const targets = Array.isArray(target) ? target : [target];

const versionOf = (prefix: string) => {
  const entry = targets.find((t): t is string => typeof t === "string" && t.startsWith(prefix));
  return entry ? parseFloat(entry.slice(prefix.length)) : null;
};

describe("iOS build-target floor", () => {
  it("reads a real deployment target out of the Xcode project", () => {
    expect(deploymentTarget).toBeGreaterThan(0);
  });

  // Both legs matter: `ios` covers the shell's WKWebView, `safari` covers iOS
  // Safari on the web build — both are pinned to the OS on an iPhone.
  it.each(["ios", "safari"])("does not let the %s build target outrun it", prefix => {
    const version = versionOf(prefix);
    expect(version, `vite.config.ts build.target must pin a "${prefix}<version>" entry`).not.toBeNull();
    expect(version!).toBeLessThanOrEqual(deploymentTarget);
  });
});
