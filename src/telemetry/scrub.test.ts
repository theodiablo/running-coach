import { describe, it, expect } from "vitest";
import { scrubEvent, scrubUrl } from "./scrub";

describe("telemetry URL scrubbing", () => {
  it("never sends a watch token", () => {
    expect(scrubUrl("https://run.example/watch/AbC123_-x")).toBe("https://run.example/watch/:token");
    expect(scrubUrl("/watch/AbC123_-x")).toBe("/watch/:token");
  });

  it("drops query strings and fragments, where auth callbacks carry their secrets", () => {
    expect(scrubUrl("https://run.example/?code=abc&state=x")).toBe("https://run.example/");
    expect(scrubUrl("https://run.example/#type=recovery&access_token=a&refresh_token=r")).toBe("https://run.example/");
    expect(scrubUrl("/pr/12/index.html?code=abc")).toBe("/pr/12/index.html");
  });

  it("scrubs every URL-shaped property, including person properties, and nothing else", () => {
    const ev = scrubEvent({
      properties: {
        $current_url: "https://run.example/watch/tok?x=1",
        $pathname: "/watch/tok",
        $referrer: "https://mail.example/?q=secret",
        $initial_current_url: "https://run.example/#access_token=a",
        environment: "production",
      },
      $set_once: { $initial_pathname: "/watch/tok" },
    });
    expect(ev.properties).toEqual({
      $current_url: "https://run.example/watch/:token",
      $pathname: "/watch/:token",
      $referrer: "https://mail.example/",
      $initial_current_url: "https://run.example/",
      environment: "production",
    });
    expect(ev.$set_once).toEqual({ $initial_pathname: "/watch/:token" });
  });

  it("passes a dropped event through", () => {
    expect(scrubEvent(null)).toBeNull();
  });
});
