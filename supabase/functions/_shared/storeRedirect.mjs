// get, pure half: which store a scanning device goes to, and whether the hit is
// counted. Plain ESM so Vitest covers it (src/utils/storeRedirect.test.ts,
// which also pins these URLs to src/constants.ts). docs/store-redirect.md.

export const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=solutions.camboulive.run";
// TestFlight until the App Store listing exists; then the listing, and set
// APP_STORE_PROVIDER_TOKEN so App Store Connect attributes each campaign.
export const IOS_URL = "https://testflight.apple.com/join/T73yu15A";
export const APP_STORE_PROVIDER_TOKEN = "";
export const WEB_URL = "https://run.camboulive.solutions/";

// iPadOS 13+ Safari claims to be a Mac, so those iPads land on the web page.
export function classifyDevice(ua) {
  const s = String(ua ?? "");
  if (/android/i.test(s)) return "android";
  if (/iphone|ipad|ipod/i.test(s)) return "ios";
  return "other";
}

// Link-preview fetchers and scripts get redirected like anyone but never counted.
export function isBot(ua) {
  const s = String(ua ?? "").replace(/cubot/gi, ""); // a phone brand, not a crawler
  return !s || /bot\b|crawl|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|curl|wget|python|headless/i.test(s);
}

export function normalizeSrc(src) {
  return String(src ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40) || "none";
}

export function targetFor(platform, src) {
  const campaign = `utm_source=${src}&utm_medium=qr`;
  if (platform === "android") return `${PLAY_STORE_URL}&referrer=${encodeURIComponent(campaign)}`;
  if (platform === "ios") {
    return APP_STORE_PROVIDER_TOKEN && IOS_URL.startsWith("https://apps.apple.com/")
      ? `${IOS_URL}${IOS_URL.includes("?") ? "&" : "?"}pt=${APP_STORE_PROVIDER_TOKEN}&ct=${src}&mt=8`
      : IOS_URL;
  }
  return `${WEB_URL}?${campaign}`;
}

export function routeScan({ method, userAgent, src }) {
  const platform = classifyDevice(userAgent);
  const tag = normalizeSrc(src);
  return {
    platform,
    src: tag,
    location: targetFor(platform, tag),
    count: method === "GET" && !isBot(userAgent),
  };
}
