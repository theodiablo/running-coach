import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error Build script ESM has no TypeScript declaration file.
import * as watchPage from "../../scripts/watch-page.mjs";
import copy from "./copy.json";

const { watchPageHtml } = watchPage as { watchPageHtml: (html: string, c: typeof copy) => string };

// watch.html is what chat apps (which never run JS) read for a /watch/ link.
const index = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
const html = watchPageHtml(index, copy);
const meta = (attr: string, key: string) =>
  html.match(new RegExp(`<meta\\s+${attr}="${key}"\\s+content="([^"]*)"`))?.[1];

describe("watch.html", () => {
  it("previews a run link as a live run, not as the homepage", () => {
    expect(html).toContain(`<title>${copy.ogWatchTitle} · ${copy.brand}</title>`);
    expect(meta("property", "og:title")).toBe(`${copy.ogWatchTitle} · ${copy.brand}`);
    expect(meta("property", "og:description")).toBe(copy.ogWatchDescription);
    expect(meta("property", "og:image")).toBe("https://run.camboulive.solutions/og-watch.png");
    expect(meta("name", "twitter:image")).toBe("https://run.camboulive.solutions/og-watch.png");
    // A canonical or og:url would send crawlers back to the homepage card.
    expect(html).not.toMatch(/rel="canonical"|property="og:url"/);
  });

  it("keeps run pages out of search and the token out of referrers without JS", () => {
    expect(meta("name", "robots")).toBe("noindex, nofollow");
    expect(meta("name", "referrer")).toBe("no-referrer");
    expect(html).not.toContain('<script type="application/ld+json">');
  });

  it("serves the same app as the homepage", () => {
    const scripts = (h: string) => h.match(/<script type="module"[^>]*>/g) ?? [];
    expect(scripts(html)).toEqual(scripts(index));
    expect(html).toContain('<div id="root">');
  });

  it("fails the build instead of shipping a half-swapped page", () => {
    expect(() => watchPageHtml(index.replace(/<meta\s+property="og:image"\s+content="[^"]*"\s*\/?>/, ""), copy))
      .toThrow(/og:image/);
  });
});
