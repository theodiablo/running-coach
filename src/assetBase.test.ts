import { describe, it, expect, vi, afterEach } from "vitest";
import viteConfig from "../vite.config";
import { WATCH_PATH_PREFIX } from "./live/shareLink";

// `base` is where a build is SERVED from, per deploy target. A wrong one doesn't 404: the SPA fallback answers
// with index.html as text/html, the module is refused, and nothing runs (no React, error boundaries or telemetry).

const loadConfig = async (env: Record<string, string>) => {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  return (await import("../vite.config")).default;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("build asset base", () => {
  // Production web. `/watch/:token` is served here by the SPA fallback, so the
  // base has to resolve identically at every path depth.
  it("defaults to the bucket root for the web build", () => {
    expect(viteConfig.base).toBe("/");
  });

  it("resolves the entry script to the same URL from the nested watch route", () => {
    const at = (from: string) =>
      new URL(`${viteConfig.base}assets/index.js`, `https://example.com${from}`).pathname;
    expect(at(`${WATCH_PATH_PREFIX}Jd6DEeOnPOaM9YX6CndSxg`)).toBe(at("/"));
  });

  // PR previews are synced to /pr/<number>/ in the same bucket. The default '/'
  // would point index.html at production's bundle at the root, where this
  // build's hashed filenames do not exist.
  it("takes an explicit subfolder base for a PR preview", async () => {
    const config = await loadConfig({ VITE_BASE: "/pr/199/" });
    expect(config.base).toBe("/pr/199/");
    expect(new URL(`${config.base}assets/index.js`, "https://example.com/pr/199/index.html").pathname)
      .toBe("/pr/199/assets/index.js");
  });

  // The shells load off a local origin root and serve no nested route, so a
  // relative base is safe there — and is what they have always shipped.
  it("stays relative for a native build", async () => {
    expect((await loadConfig({ VITE_NATIVE_BUILD: "1" })).base).toBe("./");
  });

  it("lets an explicit base win over the native default", async () => {
    expect((await loadConfig({ VITE_NATIVE_BUILD: "1", VITE_BASE: "/pr/199/" })).base).toBe("/pr/199/");
  });
});
