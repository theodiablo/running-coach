// The maintainer's address lives in MAINTAINER_EMAIL / SUPPORT_EMAIL, never in tracked files (CLAUDE.md).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
// @ts-expect-error — plain ESM script module.
import { fillSupportEmail } from "../scripts/support-email.mjs";

const PERSONAL = /[\w.+-]+@(?:gmail|googlemail|hotmail|outlook|yahoo|icloud|proton(?:mail)?)\.[a-z.]+/i;

describe("no personal email address in the repo", () => {
  it("finds none in any tracked text file", () => {
    const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
    const hits = files
      .filter((f) => !/\.(png|jpe?g|gif|webp|ico|ttf|woff2?|zip|jar|keystore|pdf)$|package-lock\.json$/.test(f))
      .flatMap((f) => {
        let text = "";
        try {
          text = readFileSync(f, "utf8");
        } catch {
          return [];
        }
        return PERSONAL.test(text) ? [f] : [];
      });
    expect(hits).toEqual([]);
  });
});

describe("support-email", () => {
  const page = '<p>Email <a href="mailto:%VITE_SUPPORT_EMAIL%">%VITE_SUPPORT_EMAIL%</a>.</p>';
  it("fills the address into the legal pages", () => {
    expect(fillSupportEmail(page, "help@example.com")).toBe(
      '<p>Email <a href="mailto:help@example.com">help@example.com</a>.</p>',
    );
  });
  it("points to the app when no address is configured", () => {
    expect(fillSupportEmail(page, "")).not.toContain("%VITE_SUPPORT_EMAIL%");
  });
});
