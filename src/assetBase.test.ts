import { describe, it, expect, vi } from "vitest";
import viteConfig from "../vite.config";
import { WATCH_PATH_PREFIX } from "./live/shareLink";

// `/watch/:token` is the app's one nested route, and it is served by the SPA
// fallback — CloudFront answers any unknown path with index.html. So index.html
// is loaded at BOTH `/` and `/watch/<token>`, and every asset URL in it has to
// mean the same thing from either depth.
//
// A relative base (`./assets/…`) does not: at `/watch/<token>` the browser
// resolves it to `/watch/assets/…`, the fallback returns index.html for that
// too, and the module is refused as `text/html`. Nothing runs — not React, not
// the ErrorBoundary, not the PostHog SDK — so the page is white and reports
// nothing. That shipped once; this keeps it from shipping again.

describe("web build asset base", () => {
  it("is root-relative, so index.html resolves assets the same at any path depth", () => {
    expect(viteConfig.base).toBe("/");
  });

  it("resolves the entry script to the same URL from the nested watch route", () => {
    const entry = new URL(`${viteConfig.base}assets/index.js`, "https://example.com/").pathname;
    const fromWatch = new URL(
      `${viteConfig.base}assets/index.js`,
      `https://example.com${WATCH_PATH_PREFIX}Jd6DEeOnPOaM9YX6CndSxg`,
    ).pathname;
    expect(fromWatch).toBe(entry);
  });

  // The shells load the bundle off a local origin and never serve the watch
  // route, so they keep the relative base they have always had.
  it("stays relative for a native build", async () => {
    vi.stubEnv("VITE_NATIVE_BUILD", "1");
    vi.resetModules();
    const nativeConfig = (await import("../vite.config")).default;
    expect(nativeConfig.base).toBe("./");
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
