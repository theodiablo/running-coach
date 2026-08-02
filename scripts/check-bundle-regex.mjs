// Fails the build if any shipped chunk contains a regex lookbehind.
//
// iOS 15/16.0-16.3 JavaScriptCore cannot *parse* `(?<=` / `(?<!` (Safari only
// shipped lookbehind in 16.4), and our iOS deployment target is 15.4. A single
// lookbehind anywhere in a chunk is fatal at parse time, not at match time: the
// whole module fails with `SyntaxError: Invalid regular expression: invalid
// group specifier name`, so the feature is dead and — for a dynamic import() —
// the rejection surfaces as an app-wide crash overlay.
//
// This bit us for real via a transitive dependency (mdast-util-gfm-autolink-literal,
// pulled in by remark-gfm for the coach chat), which is why the check scans the
// build output rather than our own source: the risk arrives with dependency
// updates, not with code we write. See patches/ for the fix.
//
// Scope is deliberately narrow. Lookbehind is unambiguous to detect in minified
// output and is the one ES2018+ regex feature that iOS 15 lacks while supporting
// everything around it (named groups, \p{...} property escapes and the `u` flag
// all work). Speculative detectors for other syntax would trade real protection
// for false positives.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist";
const LOOKBEHIND = /\(\?<[=!]/g;
// Walk everything, not just dist/assets/*.js: a chunk emitted at the dist root
// or in a nested dir ships to the device exactly the same, and index.html can
// carry an inline module script. Scoping this to one directory left those
// unguarded for no reason.
const SCANNABLE = /\.(js|mjs|cjs|html)$/;

const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? walk(path) : SCANNABLE.test(entry.name) ? [path] : [];
});

let files;
try {
  files = walk(DIST);
} catch {
  console.error(`check-bundle-regex: ${DIST} not found — run \`vite build\` first.`);
  process.exit(1);
}

if (!files.length) {
  console.error(`check-bundle-regex: no scannable files in ${DIST} — did the build emit anything?`);
  process.exit(1);
}

const offences = [];
for (const file of files) {
  const code = readFileSync(file, "utf8");
  for (const match of code.matchAll(LOOKBEHIND)) {
    // Minified output is one long line, so quote a window around the hit
    // instead of a line number — enough to recognise the offending regex.
    offences.push({ file, snippet: code.slice(Math.max(0, match.index - 60), match.index + 90) });
  }
}

if (offences.length) {
  console.error(
    `check-bundle-regex: found ${offences.length} regex lookbehind(s) in the build output.\n` +
    `These crash iOS < 16.4 at module-parse time (our iOS target is 15.4).\n`,
  );
  for (const { file, snippet } of offences) {
    console.error(`  ${file}\n    ...${snippet}...\n`);
  }
  console.error(
    "Fix the source if it's ours; if it's a dependency, patch it with\n" +
    "`npx patch-package <pkg>` (see patches/mdast-util-gfm-autolink-literal+2.0.1.patch).",
  );
  process.exit(1);
}

console.log(`check-bundle-regex: ${files.length} files clean (no lookbehind).`);
