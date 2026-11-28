// The one seam that hands a card image to the OS. Web shares the file where the
// browser can, and downloads it otherwise; the shells write it to the cache and open
// the native share sheet. docs/share-card.md ("Sharing: web vs native").
import { Capacitor } from "@capacitor/core";
import { isNative } from "../native";
import { WEB_APP_ORIGIN } from "../constants";

export type ShareResult = "shared" | "saved" | "dismissed" | "failed";

const nativePluginsAvailable = () => Capacitor.isPluginAvailable("Share") && Capacitor.isPluginAvailable("Filesystem");

// Web always (share or download); a shell only once both plugins are in it, else the action is hidden.
export function canShareImage(): boolean {
  return !isNative || nativePluginsAvailable();
}

// Whether this browser takes files through the share sheet; otherwise we download.
export function sharesFiles(file?: File): boolean {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
  try {
    return navigator.canShare({ files: [file ?? new File([], "card.png", { type: "image/png" })] });
  } catch {
    return false;
  }
}

// Whether Share opens a sheet (vs a download), for the button's label.
export function opensShareSheet(): boolean {
  return isNative ? nativePluginsAvailable() : sharesFiles();
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// The /get redirect routes each phone to its store and counts the visit under `src`
// (docs/store-redirect.md); one tag per card style says which one brings people in.
export function shareLink(style: string): string {
  return `${WEB_APP_ORIGIN}/get?src=share-${style}`;
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Both plugins reject a closed sheet with "Share canceled".
const isCancel = (err: unknown) => /cancel/i.test(err instanceof Error ? err.message : String(err ?? ""));

// Android System WebView has no navigator.share, and WKWebView's file sharing isn't reliable.
// The same file name is overwritten on each share, so the cache doesn't fill up.
async function shareNative(blob: Blob, fileName: string, text?: string): Promise<ShareResult> {
  if (!Capacitor.isPluginAvailable("Filesystem")) return "failed";
  let uri: string;
  try {
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    ({ uri } = await Filesystem.writeFile({ path: fileName, data: await toBase64(blob), directory: Directory.Cache }));
  } catch {
    return "failed";
  }
  if (!Capacitor.isPluginAvailable("Share")) return "failed";
  try {
    const { Share } = await import("@capacitor/share");
    await Share.share(text ? { files: [uri], text } : { files: [uri] });
    return "shared";
  } catch (err) {
    return isCancel(err) ? "dismissed" : "failed";
  }
}

// `text` rides along where the receiving app keeps it (messaging, mail); others drop it.
export async function shareImage(blob: Blob, fileName: string, text?: string): Promise<ShareResult> {
  if (isNative) return shareNative(blob, fileName, text);
  const file = new File([blob], fileName, { type: "image/png" });
  if (sharesFiles(file)) {
    try {
      await navigator.share(text ? { files: [file], text } : { files: [file] });
      return "shared";
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return "dismissed";
      // The tap's activation expired before the sheet opened: the image still reaches the runner.
      if (!(err instanceof Error && err.name === "NotAllowedError")) return "failed";
    }
  }
  try {
    download(blob, fileName);
    return "saved";
  } catch {
    return "failed";
  }
}
