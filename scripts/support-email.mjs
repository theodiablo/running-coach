// Fills the support address into the static legal pages, which Vite copies from public/ untouched.
// The address is VITE_SUPPORT_EMAIL (repo variable SUPPORT_EMAIL), never a literal in the repo.
// Production builds set REQUIRE_SUPPORT_EMAIL, so a privacy policy never ships without a contact.
// Usage: node scripts/support-email.mjs [dist]
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLACEHOLDER = "%VITE_SUPPORT_EMAIL%";
const LINK = new RegExp(`<a href="mailto:${PLACEHOLDER}">${PLACEHOLDER}</a>`, "g");
const PAGES = ["privacy.html", "disclaimer.html"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function fillSupportEmail(html, email) {
  // A replacer function: a string replacement would read "$&" or "$1" in the address as patterns.
  const filled = email
    ? html.replace(LINK, () => `<a href="mailto:${esc(email)}">${esc(email)}</a>`)
    : html.replace(LINK, () => "us through the app's Settings");
  if (filled.includes(PLACEHOLDER)) throw new Error(`support-email: a ${PLACEHOLDER} outside a mailto link`);
  return filled;
}

export function run(dist, env) {
  const email = (env.VITE_SUPPORT_EMAIL ?? "").trim();
  if (!email && env.REQUIRE_SUPPORT_EMAIL) {
    throw new Error("support-email: VITE_SUPPORT_EMAIL is required for this build (repo variable SUPPORT_EMAIL).");
  }
  if (!email) console.warn("support-email: VITE_SUPPORT_EMAIL is not set; the legal pages point to the app instead.");
  for (const page of PAGES) {
    const file = join(dist, page);
    if (!existsSync(file)) throw new Error(`support-email: ${file} is missing from the build`);
    writeFileSync(file, fillSupportEmail(readFileSync(file, "utf8"), email));
  }
}

// Real paths on both sides: a symlinked checkout (macOS /tmp, /var) must still run it.
const invoked = process.argv[1] && realpathSync(resolve(process.argv[1]));
if (invoked && invoked === realpathSync(fileURLToPath(import.meta.url))) {
  run(resolve(process.argv[2] ?? "dist"), process.env);
}
