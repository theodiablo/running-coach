import { beforeEach, describe, it, expect, vi } from "vitest";
import { HR_HEALTH_CONNECT_AUTH_KEY } from "../constants";
import { flushPendingHr, hasHealthConnectAuthorization, healthConnectSource, HR_PENDING_MAX_AGE_MS } from "./healthconnect";

const hc = vi.hoisted(() => ({
  checkAvailability: vi.fn<() => Promise<{ availability: string }>>(),
  checkHealthPermissions: vi.fn<() => Promise<{ hasAllPermissions?: boolean }>>(),
  requestHealthPermissions: vi.fn<() => Promise<{ hasAllPermissions?: boolean }>>(),
  readRecords: vi.fn<() => Promise<{ records?: unknown[] }>>(),
}));
vi.mock("@pianissimoproject/capacitor-health-connect", () => ({ HealthConnect: hc }));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  hc.checkAvailability.mockResolvedValue({ availability: "Available" });
  hc.checkHealthPermissions.mockResolvedValue({ hasAllPermissions: true });
});

describe("flushPendingHr", () => {
  it("clears manual, invalid, and stale pending markers without querying Health Connect", async () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    const patch = vi.fn();

    await flushPendingHr([
      { id: "manual", hr: 140, hrPending: { start: String(now - 1000), end: String(now - 500), source: "healthconnect" } },
      { id: "invalid", hrPending: { start: String(now), end: String(now - 1), source: "healthconnect" } },
      { id: "stale", hrPending: { start: String(now - HR_PENDING_MAX_AGE_MS - 2000), end: String(now - HR_PENDING_MAX_AGE_MS - 1000), source: "healthconnect" } },
    ], patch, { enabled: false, now });

    expect(patch).toHaveBeenCalledTimes(3);
    expect(patch).toHaveBeenCalledWith("manual", {});
    expect(patch).toHaveBeenCalledWith("invalid", {});
    expect(patch).toHaveBeenCalledWith("stale", {});
  });

  it("leaves fresh pending markers untouched when sync is disabled", async () => {
    const now = Date.now();
    const patch = vi.fn();

    await flushPendingHr([
      { id: "fresh", hrPending: { start: String(now - 2000), end: String(now - 1000), source: "healthconnect" } },
    ], patch, { enabled: false, now });

    expect(patch).not.toHaveBeenCalled();
  });

  it("leaves fresh pending markers untouched when native reads are deferred", async () => {
    const now = Date.now();
    const patch = vi.fn();

    await flushPendingHr([
      { id: "fresh", hrPending: { start: String(now - 2000), end: String(now - 1000), source: "healthconnect" } },
    ], patch, { enabled: true, allowNativeRead: false, now });

    expect(patch).not.toHaveBeenCalled();
  });

  it("does not touch fresh pending markers without local Health Connect authorization", async () => {
    const now = Date.now();
    const patch = vi.fn();

    await flushPendingHr([
      { id: "fresh", hrPending: { start: String(now - 2000), end: String(now - 1000), source: "healthconnect" } },
    ], patch, { enabled: true, allowNativeRead: true, now });

    expect(hasHealthConnectAuthorization()).toBe(false);
    expect(patch).not.toHaveBeenCalled();
  });

  it("recognizes the local Health Connect authorization marker", () => {
    localStorage.setItem(HR_HEALTH_CONNECT_AUTH_KEY, "1");

    expect(hasHealthConnectAuthorization()).toBe(true);
  });
});

describe("healthConnectSource.checkPermissions", () => {
  // The permission bridge is a process-killer when Health Connect is missing
  // (uncaught coroutine exception in the plugin — no promise ever rejects), so
  // "unavailable" must be answered without calling it at all. This is what made
  // Settings → Integrations close the app on every Android 13-and-below device
  // without the Health Connect app installed.
  it("answers false without touching the permission bridge when unavailable", async () => {
    localStorage.setItem(HR_HEALTH_CONNECT_AUTH_KEY, "1");
    hc.checkAvailability.mockResolvedValue({ availability: "NotSupported" });

    expect(await healthConnectSource.checkPermissions()).toBe(false);
    expect(hc.checkHealthPermissions).not.toHaveBeenCalled();
    expect(hasHealthConnectAuthorization()).toBe(false);
  });

  it("answers false without touching the permission bridge when Health Connect needs installing", async () => {
    hc.checkAvailability.mockResolvedValue({ availability: "NotInstalled" });

    expect(await healthConnectSource.checkPermissions()).toBe(false);
    expect(hc.checkHealthPermissions).not.toHaveBeenCalled();
  });

  it("reads the real grant once Health Connect is available", async () => {
    expect(await healthConnectSource.checkPermissions()).toBe(true);
    expect(hc.checkHealthPermissions).toHaveBeenCalledTimes(1);
    expect(hasHealthConnectAuthorization()).toBe(true);
  });

  it("clears the local marker when the grant was revoked", async () => {
    localStorage.setItem(HR_HEALTH_CONNECT_AUTH_KEY, "1");
    hc.checkHealthPermissions.mockResolvedValue({ hasAllPermissions: false });

    expect(await healthConnectSource.checkPermissions()).toBe(false);
    expect(hasHealthConnectAuthorization()).toBe(false);
  });
});
