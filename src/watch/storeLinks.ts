// Where the public watch page sends a visitor who wants the app. Pure, so the
// platform sniff and the tracking contract are pinned by tests.
import { PLAY_STORE_URL, TESTFLIGHT_BETA_URL } from "../constants";

export type VisitorPlatform = "android" | "ios" | "desktop";

// Which placement a click came from, carried as utm_content.
export type PromoPlacement = "idle" | "live" | "ended" | "sheet" | "footer";

// iPadOS reports a Mac user agent, so a Mac with a touchscreen is an iPad.
export function visitorPlatform(ua: string, maxTouchPoints = 0): VisitorPlatform {
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/macintosh/i.test(ua) && maxTouchPoints > 1) return "ios";
  return "desktop";
}

// Never the share token: it is the only thing guarding the run, and UTMs end up
// in store consoles and analytics.
const utm = (placement: PromoPlacement) =>
  `utm_source=live_share&utm_medium=watch_page&utm_campaign=race_link&utm_content=${placement}`;

export const playStoreLink = (placement: PromoPlacement) => `${PLAY_STORE_URL}&${utm(placement)}`;

// TestFlight ignores query parameters, so there is nothing to tag.
export const iosBetaLink = () => TESTFLIGHT_BETA_URL;

export const siteLink = (placement: PromoPlacement) => `/?${utm(placement)}`;
