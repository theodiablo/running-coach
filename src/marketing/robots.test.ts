import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const robots = readFileSync(resolve(__dirname, "../../public/robots.txt"), "utf8");

// RFC 9309: a crawler obeys only the group naming it (else `*`); longest rule wins, Allow on a tie.
function allowed(agent: string, path: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; prefix: string }[] }[] = [];
  let open = false;
  for (const raw of robots.split("\n")) {
    const [key, ...rest] = raw.replace(/#.*/, "").split(":");
    const k = key.trim().toLowerCase();
    const v = rest.join(":").trim();
    if (k === "user-agent") {
      if (!open) groups.push({ agents: [], rules: [] });
      groups[groups.length - 1].agents.push(v.toLowerCase());
      open = true;
    } else if (k === "allow" || k === "disallow") {
      open = false;
      if (v) groups[groups.length - 1].rules.push({ allow: k === "allow", prefix: v });
    }
  }
  const group = groups.find(g => g.agents.includes(agent.toLowerCase()))
    ?? groups.find(g => g.agents.includes("*"));
  const hit = group?.rules
    .filter(r => path.startsWith(r.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length || Number(b.allow) - Number(a.allow))[0];
  return hit?.allow ?? true;
}

describe("robots.txt", () => {
  const run = "/watch/44_Z5NRGwhyAYvIcqwXFRQ";

  it("keeps run links away from crawlers that would go looking", () => {
    expect(allowed("Googlebot", run)).toBe(false);
    expect(allowed("Bingbot", run)).toBe(false);
    expect(allowed("Googlebot", "/")).toBe(true);
  });

  it("lets the link-preview fetchers that honour it read a shared run link", () => {
    for (const bot of ["LinkedInBot", "Twitterbot"]) {
      expect(allowed(bot, run)).toBe(true);
      expect(allowed(bot, "/og-watch.png")).toBe(true);
    }
  });
});
