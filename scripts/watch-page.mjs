// Writes dist/watch.html: the built index.html with the /watch/:token link
// preview (title, description, og-watch.png) and a static noindex. Chat apps
// never run JavaScript, so without it every shared run link previews as the
// homepage. Meant to be served by CloudFront for /watch/*; the app itself is
// the same bundle and still routes on the URL. Usage: node scripts/watch-page.mjs [dist]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://run.camboulive.solutions";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function swap(html, pattern, replacement, label) {
  const matches = html.match(new RegExp(pattern.source, "g")) || [];
  if (matches.length !== 1) throw new Error(`watch-page: expected one ${label} in index.html, found ${matches.length}`);
  return html.replace(pattern, replacement);
}

export function watchPageHtml(indexHtml, copy) {
  const title = esc(`${copy.ogWatchTitle} · ${copy.brand}`);
  const desc = esc(copy.ogWatchDescription);
  const meta = (attr, key) => new RegExp(`<meta\\s+${attr}="${key}"\\s+content="[^"]*"\\s*\\/?>`);
  let h = indexHtml;
  h = swap(h, /<title>[^<]*<\/title>/, `<title>${title}</title>`, "<title>");
  h = swap(h, meta("name", "description"), `<meta name="description" content="${desc}" />`, "description");
  // No canonical or og:url: either would point crawlers back at the homepage card.
  h = swap(h, /\s*<link\s+rel="canonical"[^>]*>/, "", "canonical");
  h = swap(h, meta("property", "og:url"), "", "og:url");
  h = swap(h, meta("name", "robots"),
    `<meta name="robots" content="noindex, nofollow" />\n    <meta name="referrer" content="no-referrer" />`, "robots");
  h = swap(h, meta("property", "og:title"), `<meta property="og:title" content="${title}" />`, "og:title");
  h = swap(h, meta("property", "og:description"), `<meta property="og:description" content="${desc}" />`, "og:description");
  h = swap(h, meta("property", "og:image"), `<meta property="og:image" content="${ORIGIN}/og-watch.png" />`, "og:image");
  h = swap(h, meta("property", "og:image:alt"), `<meta property="og:image:alt" content="${title}" />`, "og:image:alt");
  h = swap(h, meta("name", "twitter:title"), `<meta name="twitter:title" content="${title}" />`, "twitter:title");
  h = swap(h, meta("name", "twitter:description"), `<meta name="twitter:description" content="${desc}" />`, "twitter:description");
  h = swap(h, meta("name", "twitter:image"), `<meta name="twitter:image" content="${ORIGIN}/og-watch.png" />`, "twitter:image");
  // The app's structured data describes the homepage, not a run.
  h = swap(h, /\s*<script type="application\/ld\+json">[\s\S]*?<\/script>/, "", "JSON-LD block");
  return h;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dist = resolve(process.argv[2] || join(root, "dist"));
  const copy = JSON.parse(readFileSync(join(root, "src", "marketing", "copy.json"), "utf8"));
  writeFileSync(join(dist, "watch.html"), watchPageHtml(readFileSync(join(dist, "index.html"), "utf8"), copy));
  console.log(`watch-page: wrote ${join(dist, "watch.html")}`);
}
