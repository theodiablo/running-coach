import { supabase } from "./supabase";

// The opt-in name other runners see in a race field (docs/race-field.md). Lives on
// profiles, never in the app_state blob. The server constraint is the authority;
// publicNameIssue mirrors it so the field can say what's wrong before saving.

export const PUBLIC_NAME_MAX = 24;

export type PublicNameIssue = "short" | "long" | "spaces" | "invisible" | "link" | "letter";

// Control, zero-width, bidi-override and blank-rendering "letter" code points, as [from, to] ranges.
const INVISIBLE_RANGES: [number, number][] = [
  [0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x180e, 0x180e],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xe0000, 0xe007f],
];
const hasInvisible = (s: string) => [...s].some(ch => {
  const cp = ch.codePointAt(0) ?? 0;
  return INVISIBLE_RANGES.some(([a, b]) => cp >= a && cp <= b);
});
const LINK = /(https?:|www\.|:\/\/|@|\.(com|net|org|io|fr|es)\b)/i;

// Collapse what the server would refuse but a person means the same by.
export const normalizePublicName = (raw: string) => raw.normalize("NFC").replace(/\s+/g, " ").trim();

export function publicNameIssue(name: string): PublicNameIssue | null {
  if (hasInvisible(name)) return "invisible";
  if (/^\s|\s$|\s{2,}/.test(name)) return "spaces";
  const len = [...name].length;
  if (len < 2) return "short";
  if (len > PUBLIC_NAME_MAX) return "long";
  if (LINK.test(name)) return "link";
  if (!/\p{L}/u.test(name)) return "letter";
  return null;
}

// undefined = the read failed (show a retry, never an empty field that a save would then overwrite).
export async function fetchPublicName(uid: string): Promise<string | null | undefined> {
  try {
    const { data, error } = await supabase.from("profiles").select("public_name").eq("id", uid).maybeSingle();
    if (error) return undefined;
    const value = data?.public_name;
    return typeof value === "string" && value ? value : null;
  } catch {
    return undefined;
  }
}

// An update, never an upsert: there is no insert grant on public_name.
export async function savePublicName(uid: string, name: string | null): Promise<boolean> {
  try {
    const { error } = await supabase.from("profiles").update({ public_name: name }).eq("id", uid);
    return !error;
  } catch {
    return false;
  }
}
