import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CoachText } from "./components/CoachText";
import { COACH_LINK_TARGETS } from "./utils/coachLinks";

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

// The coach is instructed never to emit a URL, but a prompt rule is not
// enforcement: a mistral-era reply shipped fabricated YouTube links for
// strengthening drills. CoachText renders link TEXT without the href, so a
// hallucinated URL can never become something the runner can follow.
describe("CoachText neutralises links", () => {
  const coach = (md: string) => render(<CoachText text={md}/>).container;

  it("keeps a markdown link's text but drops the anchor", () => {
    const c = coach("Try [clamshells](https://youtube.com/watch?v=fake).");
    expect(c.querySelector("a")).toBeNull();
    expect(c.textContent).toContain("clamshells");
  });

  it("does not linkify a bare URL", () => {
    expect(coach("see www.example.com").querySelector("a")).toBeNull();
    expect(coach("see https://example.com/drills").querySelector("a")).toBeNull();
  });

  it("does not linkify a bare email", () => {
    expect(coach("mail bob@example.com").querySelector("a")).toBeNull();
  });

  it("leaves the rest of the coach's formatting intact", () => {
    const c = coach("**Week 3**\n\n- easy 5 km\n- rest");
    expect(c.querySelector("strong")?.textContent).toBe("Week 3");
    expect(c.querySelectorAll("li")).toHaveLength(2);
  });
});

// The coach's one sanctioned link: an allowlisted `app:` target becomes a
// button that lands the runner on the screen. It exists because the coach
// cannot change the goal itself — "adjust it in the plan settings" was prose
// with no way to get there, in the one place it structurally has to hand off.
describe("CoachText in-app links", () => {
  const withNav = (md: string) => {
    const onNavigate = vi.fn();
    const c = render(<CoachText text={md} onNavigate={onNavigate}/>).container;
    return { c, onNavigate };
  };

  it("renders an allowlisted target as a button that navigates", () => {
    const { c, onNavigate } = withNav("You can [change your goal](app:goal) any time.");
    const btn = c.querySelector("button");
    expect(btn?.textContent).toBe("change your goal");
    fireEvent.click(btn!);
    expect(onNavigate).toHaveBeenCalledWith("goal");
  });

  it("supports every documented target", () => {
    for (const target of COACH_LINK_TARGETS) {
      const { c, onNavigate } = withNav(`go [there](app:${target})`);
      fireEvent.click(c.querySelector("button")!);
      expect(onNavigate).toHaveBeenCalledWith(target);
      cleanup();
    }
  });

  it("drops an unknown app: target to plain text", () => {
    const { c } = withNav("try [this](app:admin-panel)");
    expect(c.querySelector("button")).toBeNull();
    expect(c.textContent).toContain("this");
  });

  it("never turns an external URL into a button, even with nav wired", () => {
    const { c } = withNav("watch [clamshells](https://youtube.com/watch?v=fake)");
    expect(c.querySelector("button")).toBeNull();
    expect(c.querySelector("a")).toBeNull();
  });

  it("stays inert text when no navigation handler is available", () => {
    const c = render(<CoachText text="[change your goal](app:goal)"/>).container;
    expect(c.querySelector("button")).toBeNull();
    expect(c.textContent).toContain("change your goal");
  });
});
