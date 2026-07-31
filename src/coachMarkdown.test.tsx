import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

afterEach(cleanup);

// Guards patches/mdast-util-gfm-autolink-literal+2.0.1.patch, which strips a
// regex lookbehind that iOS < 16.4 cannot parse (it took the whole CoachChat
// chunk down — see scripts/check-bundle-regex.mjs). The lookbehind only
// restated a check `findEmail` already performs in JS, so autolinking must
// behave exactly as upstream does; these cases pin that down. Rendered the way
// CoachChat renders the coach's markdown replies.
const html = (md: string) =>
  render(<ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>).container.innerHTML;

describe("coach markdown autolinking (patched remark-gfm)", () => {
  it("still autolinks a bare email", () => {
    expect(html("Mail bob@example.com now")).toContain('href="mailto:bob@example.com"');
    expect(html("bob@example.com")).toContain('href="mailto:bob@example.com"');
  });

  it("still refuses an email preceded by a slash", () => {
    expect(html("/bob@example.com")).not.toContain("mailto:");
  });

  // The lookbehind was what stopped the scan mid-word, so this is the case most
  // at risk from removing it: a rejected match must not swallow a later valid one.
  it("keeps scanning after a rejected match", () => {
    const out = html("path/to/a@b.com and real bob@example.com");
    expect(out).toContain('href="mailto:bob@example.com"');
    expect(out).not.toContain("mailto:a@b.com");
  });

  it("leaves the rest of GFM intact", () => {
    expect(html("see www.example.com")).toContain('href="http://www.example.com"');
    expect(html("| a | b |\n| - | - |\n| 1 | 2 |")).toContain("<table>");
    expect(html("~~gone~~")).toContain("<del>");
  });
});
