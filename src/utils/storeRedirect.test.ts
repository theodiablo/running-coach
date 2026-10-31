import { describe, it, expect } from "vitest";
import { PLAY_STORE_URL, TESTFLIGHT_BETA_URL, APP_STORE_URL } from "../constants";
import {
  PLAY_STORE_URL as SHARED_PLAY,
  IOS_URL,
  classifyDevice,
  isBot,
  normalizeSrc,
  routeScan,
  // @ts-expect-error — plain ESM module shared with the get edge function.
} from "../../supabase/functions/_shared/storeRedirect.mjs";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const IPADOS_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

describe("store targets", () => {
  it("match the app's own store links", () => {
    expect(SHARED_PLAY).toBe(PLAY_STORE_URL);
    expect(IOS_URL).toBe(APP_STORE_URL || TESTFLIGHT_BETA_URL);
  });
});

describe("classifyDevice", () => {
  it.each([
    [IPHONE, "ios"],
    [ANDROID, "android"],
    [IPADOS_DESKTOP, "other"],
    [WINDOWS, "other"],
    [null, "other"],
  ])("%s → %s", (ua, platform) => {
    expect(classifyDevice(ua)).toBe(platform);
  });
});

describe("isBot", () => {
  it("drops preview fetchers and empty agents, keeps browsers", () => {
    expect(isBot("WhatsApp/2.23.20 A")).toBe(true);
    expect(isBot("facebookexternalhit/1.1")).toBe(true);
    expect(isBot("curl/8.5.0")).toBe(true);
    expect(isBot("")).toBe(true);
    expect(isBot(IPHONE)).toBe(false);
    expect(isBot(ANDROID)).toBe(false);
    expect(isBot("Mozilla/5.0 (Linux; Android 13; CUBOT_X30) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36")).toBe(false);
  });
});

describe("normalizeSrc", () => {
  it("keeps a bounded slug and nothing else", () => {
    expect(normalizeSrc("Gym-Oct_26")).toBe("gym-oct_26");
    expect(normalizeSrc("<script>")).toBe("script");
    expect(normalizeSrc("x".repeat(60))).toHaveLength(40);
    expect(normalizeSrc(null)).toBe("none");
    expect(normalizeSrc("!!!")).toBe("none");
  });
});

describe("routeScan", () => {
  it("sends Android to Play with the campaign as install referrer", () => {
    const r = routeScan({ method: "GET", userAgent: ANDROID, src: "gym" });
    expect(r).toMatchObject({ platform: "android", src: "gym", count: true });
    expect(r.location).toBe(`${PLAY_STORE_URL}&referrer=utm_source%3Dgym%26utm_medium%3Dqr`);
  });

  it("sends iPhone to TestFlight while there is no App Store listing", () => {
    expect(routeScan({ method: "GET", userAgent: IPHONE, src: "gym" }).location).toBe(TESTFLIGHT_BETA_URL);
  });

  it("sends everything else to the web app with utm tags", () => {
    expect(routeScan({ method: "GET", userAgent: WINDOWS, src: null }).location).toBe(
      "https://run.camboulive.solutions/?utm_source=none&utm_medium=qr",
    );
  });

  it("redirects but does not count HEAD requests or bots", () => {
    expect(routeScan({ method: "HEAD", userAgent: IPHONE, src: "" }).count).toBe(false);
    const bot = routeScan({ method: "GET", userAgent: "Slackbot-LinkExpanding 1.0", src: "" });
    expect(bot.count).toBe(false);
    expect(bot.location).toContain("run.camboulive.solutions");
  });
});
