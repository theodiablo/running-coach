// Fills the support address into the static legal pages, which Vite copies from public/ untouched.
// The address is VITE_SUPPORT_EMAIL (repo variable SUPPORT_EMAIL), never a literal in the repo.
// Usage: node scripts/support-email.mjs [dist]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PLACEHOLDER = "%VITE_SUPPORT_EMAIL%";
const LINK = new RegExp(`<a href="mailto:${PLACEHOLDER}">${PLACEHOLDER}</a>`, "g");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function fillSupportEmail(html, email) {
  const filled = email
    ? html.replace(LINK, `<a href="mailto:${esc(email)}">${esc(email)}</a>`)
    : html.replace(LINK, "us through the app (Settings, then Help &amp; FAQ)");
  if (filled.includes(PLACEHOLDER)) throw new Error(`support-email: a ${PLACEHOLDER} outside a mailto link`);
  return filled;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dist = resolve(process.argv[2] ?? "dist");
  const email = (process.env.VITE_SUPPORT_EMAIL ?? "").trim();
  if (!email) console.warn("support-email: VITE_SUPPORT_EMAIL is not set; the legal pages point to the app instead.");
  for (const page of ["privacy.html", "disclaimer.html"]) {
    const file = join(dist, page);
    if (existsSync(file)) writeFileSync(file, fillSupportEmail(readFileSync(file, "utf8"), email));
  }
}
