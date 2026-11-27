// The card's two families, loaded into document.fonts before the first draw: a
// canvas drawn before its font is ready falls back silently and never redraws.
import archivo800 from "@fontsource/archivo/files/archivo-latin-800-normal.woff2?url";
import archivo800x from "@fontsource/archivo/files/archivo-latin-ext-800-normal.woff2?url";
import archivo900 from "@fontsource/archivo/files/archivo-latin-900-normal.woff2?url";
import archivo900x from "@fontsource/archivo/files/archivo-latin-ext-900-normal.woff2?url";
import inter400 from "@fontsource/inter/files/inter-latin-400-normal.woff2?url";
import inter400x from "@fontsource/inter/files/inter-latin-ext-400-normal.woff2?url";
import inter600 from "@fontsource/inter/files/inter-latin-600-normal.woff2?url";
import inter600x from "@fontsource/inter/files/inter-latin-ext-600-normal.woff2?url";
import inter700 from "@fontsource/inter/files/inter-latin-700-normal.woff2?url";
import inter700x from "@fontsource/inter/files/inter-latin-ext-700-normal.woff2?url";

// The subsets' ranges, as @fontsource declares them in its combined stylesheets.
const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

const FACES: [family: string, weight: number, latin: string, ext: string][] = [
  ["Archivo", 800, archivo800, archivo800x],
  ["Archivo", 900, archivo900, archivo900x],
  ["Inter", 400, inter400, inter400x],
  ["Inter", 600, inter600, inter600x],
  ["Inter", 700, inter700, inter700x],
];

let loading: Promise<void> | null = null;

// Resolves even when a face fails: the card then draws in the fallback font
// rather than never drawing.
export function loadCardFonts(): Promise<void> {
  if (loading) return loading;
  if (typeof document === "undefined" || !("fonts" in document) || typeof FontFace === "undefined") return Promise.resolve();
  const faces = FACES.flatMap(([family, weight, latin, ext]) => [
    new FontFace(family, `url(${latin}) format("woff2")`, { weight: String(weight), unicodeRange: LATIN }),
    new FontFace(family, `url(${ext}) format("woff2")`, { weight: String(weight), unicodeRange: LATIN_EXT }),
  ]);
  // A face that failed (offline on first open) is retried on the next open.
  loading = Promise.all(faces.map(f => f.load().then(loaded => { document.fonts.add(loaded); return true; }, () => false)))
    .then(ok => { if (ok.includes(false)) loading = null; });
  return loading;
}
