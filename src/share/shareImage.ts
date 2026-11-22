// The one seam that hands a card image to the OS. Web shares the file where the
// browser can, and downloads it otherwise; native shells get their own path in a
// later PR, so the action is hidden there until then. docs/share-card.md.
import { isNative } from "../native";

export type ShareResult = "shared" | "saved" | "dismissed" | "failed";

export function canShareImage(): boolean {
  return !isNative;
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

export async function shareImage(blob: Blob, fileName: string): Promise<ShareResult> {
  const file = new File([blob], fileName, { type: "image/png" });
  if (sharesFiles(file)) {
    try {
      // Files only: a text or url alongside makes some apps drop the image.
      await navigator.share({ files: [file] });
      return "shared";
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return "dismissed";
      return "failed";
    }
  }
  try {
    download(blob, fileName);
    return "saved";
  } catch {
    return "failed";
  }
}
