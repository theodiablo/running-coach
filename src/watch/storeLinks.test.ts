import { describe, it, expect } from "vitest";
import { visitorPlatform, playStoreLink, iosBetaLink, siteLink } from "./storeLinks";
import { PLAY_STORE_URL, TESTFLIGHT_BETA_URL } from "../constants";

const UA = {
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36",
};

describe("visitorPlatform", () => {
  it("puts each visitor's own store first", () => {
    expect(visitorPlatform(UA.android)).toBe("android");
    expect(visitorPlatform(UA.iphone)).toBe("ios");
    expect(visitorPlatform(UA.windows)).toBe("desktop");
    expect(visitorPlatform(UA.mac)).toBe("desktop");
  });

  it("recognises an iPad behind its desktop Mac user agent", () => {
    expect(visitorPlatform(UA.mac, 5)).toBe("ios");
  });
});

describe("store links", () => {
  it("tags the Play listing with the placement the tap came from", () => {
    const url = new URL(playStoreLink("ended"));
    expect(url.href.startsWith(PLAY_STORE_URL)).toBe(true);
    expect(url.searchParams.get("id")).toBe("solutions.camboulive.run");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      utm_source: "live_share", utm_medium: "watch_page", utm_campaign: "race_link", utm_content: "ended",
    });
  });

  it("sends iPhone visitors to the public TestFlight beta", () => {
    expect(iosBetaLink()).toBe(TESTFLIGHT_BETA_URL);
  });

  it("points the site link at the landing page, tagged", () => {
    expect(siteLink("footer")).toMatch(/^\/\?utm_source=live_share&.*utm_content=footer$/);
  });
});
