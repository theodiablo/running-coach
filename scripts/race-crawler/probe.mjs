// Asks each candidate race source for one page, as the crawler would, and prints what came back:
// run from GitHub's runners (race-source-probe.yml) to see which sites refuse them. docs/race-crawler.md.
const USER_AGENT = "running-coach-race-crawler/1.0 (weekly; race catalogue)";
const TARGETS = [
  ["rockthesport (control)", "https://web.rockthesport.com/sitemap/events-es-pt.xml"],
  ["findarace sitemap", "https://findarace.com/sitemap/events-future.xml"],
  // running.life: whether its race sitemaps, unlike its pages, pass Cloudflare.
  ["running.life calendar", "https://running.life/running-calendar/ireland"],
  ["running.life race sitemap", "https://running.life/sitemap-races-1.xml"],
  // France, first-hand: registration and timing platforms.
  ["ats-sport sitemap", "https://ats-sport.com/sitemap.xml"],
  ["ats-sport event", "https://ats-sport.com/epreuve.php?id_epreuve=9138"],
  ["geo.api.gouv.fr commune", "https://geo.api.gouv.fr/communes?nom=Saint-Girons&codeDepartement=09&fields=nom,centre"],
  ["protiming home", "https://www.protiming.fr/"],
  ["protiming event", "https://www.protiming.fr/events/8537-la-course-des-3-ponts"],
  ["le-sportif calendar", "https://www.le-sportif.com/Calendar/CalendarSearch.aspx"],
  ["klikego home", "https://www.klikego.com/"],
  ["njuko sitemap", "https://njuko.com/sitemap.xml"],
  // Ireland: RunIreland's calendar is empty since 2020, so these instead.
  ["eventmaster.ie", "https://eventmaster.ie/"],
  ["popupraces.ie sitemap", "https://www.popupraces.ie/sitemap_index.xml"],
];

const rows = [];
for (const [label, url] of TARGETS) {
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(60_000) });
    const body = await res.text();
    // Cloudflare's interstitial, not the word "captcha" in an ordinary page's form.
    // Cloudflare's interstitial: its title, or its script on a refusal (normal pages carry the script too).
    const challenge = /<title>\s*just a moment/i.test(body) || (res.status >= 400 && /cdn-cgi\/challenge-platform/.test(body));
    const events = (body.match(/SportsEvent|"events":\s*\[|<url>/g) ?? []).length;
    rows.push([label, String(res.status), res.headers.get("server") ?? "", String(body.length), challenge ? "yes" : "", String(events), `${Date.now() - started} ms`]);
  } catch (err) {
    rows.push([label, "error", "", "", "", "", err.message]);
  }
  await new Promise((r) => setTimeout(r, 1000));
}

const md = [
  "| Source | HTTP | Server | Bytes | Challenge | Events/URLs | Time |",
  "|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.join(" | ")} |`),
].join("\n");
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Race source probe\n\n${md}\n`);
}
