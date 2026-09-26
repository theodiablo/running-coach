// Regenerates the two 1200x630 social-share cards from src/marketing/copy.json:
// public/og-image.png (template.html, site and app links) and
// public/og-watch.png (watch-template.html, /watch/:token links), so neither
// card can drift from the marketing copy.
//
// Usage:  npm run og:image
//
// Needs a Chromium/Chrome binary. It is located in this order:
//   1. $CHROME_BIN               (CI sets this via browser-actions/setup-chrome)
//   2. a Playwright chromium under $PLAYWRIGHT_BROWSERS_PATH (dev sandboxes)
//   3. common system paths (google-chrome / chromium)
// No npm dependencies — just Node builtins shelling out to the browser.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const CARDS = [
  { template: "template.html", out: join(repoRoot, "public", "og-image.png") },
  { template: "watch-template.html", out: join(repoRoot, "public", "og-watch.png") },
];
const WIDTH = 1200;
const HEIGHT = 630;

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function findChrome() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  // Playwright-style install (dev sandbox): pick the newest chromium build.
  const pwRoot = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (pwRoot && existsSync(pwRoot)) {
    const candidates = readdirSync(pwRoot)
      .filter((d) => d.startsWith("chromium-"))
      .map((d) => join(pwRoot, d, "chrome-linux", "chrome"))
      .filter((p) => existsSync(p));
    if (candidates.length) return candidates.sort().reverse()[0];
  }
  const system = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const p of system) if (existsSync(p)) return p;
  throw new Error(
    "No Chrome/Chromium found. Set CHROME_BIN to a Chrome binary and retry.",
  );
}

function buildHtml(templateName) {
  const copy = JSON.parse(
    readFileSync(join(repoRoot, "src", "marketing", "copy.json"), "utf8"),
  );
  const template = readFileSync(join(here, templateName), "utf8");
  return template
    .replaceAll("{{ASSETS}}", `file://${here}`)
    .replaceAll("{{BRAND}}", escapeHtml(copy.brand))
    .replace("{{HERO1}}", escapeHtml(copy.heroLine1))
    .replace("{{HERO2}}", escapeHtml(copy.heroLine2))
    .replace("{{TAGLINE}}", escapeHtml(copy.ogTagline))
    .replace("{{TITLE}}", escapeHtml(copy.ogWatchTitle))
    .replace("{{LINE}}", escapeHtml(copy.ogWatchLine));
}

// Drives Chrome over its DevTools pipe (fd 3 in, fd 4 out) instead of the
// --screenshot flag: new headless subtracts invisible browser UI from
// --window-size, so a flag-sized capture paints only ~543 of the 630 rows.
function cdpSession(chrome) {
  const proc = spawn(chrome, [
    "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
    "--allow-file-access-from-files", "--remote-debugging-pipe", "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  let id = 0, buf = "";
  const pending = new Map();
  const events = [];
  proc.stdio[4].on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      } else if (msg.method) events.push(msg);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const msg = { id: ++id, method, params, ...(sessionId ? { sessionId } : {}) };
    pending.set(msg.id, { resolve, reject });
    proc.stdio[3].write(JSON.stringify(msg) + "\0");
  });
  return { send, events, close: () => proc.kill() };
}

async function render(cdp, workDir, { template, out }) {
  const htmlPath = join(workDir, template);
  writeFileSync(htmlPath, buildHtml(template));

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method, params) => cdp.send(method, params, sessionId);
  await s("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await s("Page.enable");
  await s("Page.navigate", { url: `file://${htmlPath}` });
  // Wait for the page and its local @font-face files before capturing.
  await s("Runtime.evaluate", {
    expression: "new Promise(r => (document.readyState === 'complete' ? r() : addEventListener('load', r))).then(() => document.fonts.ready).then(() => true)",
    awaitPromise: true,
  });
  const { data } = await s("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
  });
  await cdp.send("Target.closeTarget", { targetId });
  writeFileSync(out, Buffer.from(data, "base64"));

  // Sanity-check the output really is a 1200x630 PNG.
  const png = readFileSync(out);
  const isPng = png.length > 24 && png[0] === 0x89 && png[1] === 0x50;
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  if (!isPng || w !== WIDTH || h !== HEIGHT) {
    throw new Error(`Unexpected output for ${out}: isPng=${isPng} ${w}x${h}`);
  }
  console.log(`Wrote ${out} (${w}x${h}, ${png.length} bytes)`);
}

async function main() {
  const chrome = findChrome();
  const workDir = mkdtempSync(join(tmpdir(), "og-image-"));
  const cdp = cdpSession(chrome);
  try {
    for (const card of CARDS) await render(cdp, workDir, card);
  } finally {
    cdp.close();
  }
  console.log(`Rendered with ${chrome}`);
}

await main();
