import { describe, it, expect, vi, beforeEach } from "vitest";
import { Geolocation } from "@capacitor/geolocation";
import { adaptBgLocation, adaptBgError, ensureForegroundPermission, nativeSource } from "./native";

vi.mock("@capacitor/geolocation", () => ({
  Geolocation: { checkPermissions: vi.fn(), getCurrentPosition: vi.fn(), clearWatch: vi.fn(), watchPosition: vi.fn() },
}));
vi.mock("@capacitor/core", () => ({
  registerPlugin: () => ({}),
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
}));

// The native background-geolocation plugin hands us a flat `location` object; the
// rest of the tracker (onPos, accuracyOK) reads the GeolocationPosition shape.
// These pure adapters bridge the two — verify the mapping so a plugin field
// rename can't silently break recording.
describe("adaptBgLocation", () => {
  it("maps plugin fields onto coords + timestamp", () => {
    const pos = adaptBgLocation({
      latitude: 48.8584, longitude: 2.2945, accuracy: 7, altitude: 35,
      altitudeAccuracy: 3, bearing: 90, speed: 2.5, time: 1700000000000,
    });
    expect(pos.coords.latitude).toBe(48.8584);
    expect(pos.coords.longitude).toBe(2.2945);
    expect(pos.coords.accuracy).toBe(7);
    expect(pos.coords.altitude).toBe(35);
    expect(pos.coords.heading).toBe(90); // bearing → heading
    expect(pos.timestamp).toBe(1700000000000);
  });

  it("keeps null altitude/accuracy null (some phones omit them)", () => {
    const pos = adaptBgLocation({ latitude: 1, longitude: 2, altitude: null, accuracy: null });
    expect(pos.coords.altitude).toBeNull();
    expect(pos.coords.accuracy).toBeNull();
  });

  it("falls back to now when the plugin omits a timestamp", () => {
    const before = Date.now();
    const pos = adaptBgLocation({ latitude: 1, longitude: 2 });
    expect(pos.timestamp).toBeGreaterThanOrEqual(before);
  });
});

describe("adaptBgError", () => {
  it("maps NOT_AUTHORIZED to a PERMISSION_DENIED-coded error", () => {
    const err = adaptBgError({ code: "NOT_AUTHORIZED", message: "denied" });
    // onErr in useRunTracker reads `err.code === err.PERMISSION_DENIED`.
    expect(err.code).toBe(err.PERMISSION_DENIED);
    expect(err.message).toBe("denied");
  });

  it("maps other errors to POSITION_UNAVAILABLE", () => {
    const err = adaptBgError({ code: "SOMETHING_ELSE" });
    expect(err.code).toBe(err.POSITION_UNAVAILABLE);
  });
});

// Regression coverage for the "no permission prompt at all" bug: on Android,
// Geolocation.checkPermissions()/requestPermissions() reject immediately with
// "location services disabled" BEFORE ever showing the OS dialog when the
// device's system Location toggle is off. ensureForegroundPermission must fall
// back to a real getCurrentPosition() probe in that case — that call has no such
// gate, so it's the one that actually surfaces the permission + "turn on
// location" dialogs.
describe("ensureForegroundPermission", () => {
  beforeEach(() => vi.clearAllMocks());

  const checkPermissions = vi.mocked(Geolocation.checkPermissions);
  const getCurrentPosition = vi.mocked(Geolocation.getCurrentPosition);

  const permission = (
    location: "granted" | "denied",
    coarseLocation: "granted" | "denied" = "denied",
  ) => ({
    location,
    coarseLocation,
  }) as Awaited<ReturnType<typeof Geolocation.checkPermissions>>;
  const position = () => ({
    coords: { latitude: 1, longitude: 2 },
  }) as Awaited<ReturnType<typeof Geolocation.getCurrentPosition>>;

  it("returns true on the fast path when fine location is already granted", async () => {
    checkPermissions.mockResolvedValue(permission("granted"));
    await expect(ensureForegroundPermission()).resolves.toBe(true);
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  // The precise-location fix: a high-accuracy ask requests FINE so the OS dialog
  // offers the "Precise" toggle. Requesting coarse-only (enableHighAccuracy:false)
  // is why users could only ever grant "Approximate".
  it("requests precise (enableHighAccuracy) when highAccuracy is set", async () => {
    checkPermissions.mockResolvedValue(permission("denied"));
    getCurrentPosition.mockResolvedValue(position());
    await expect(ensureForegroundPermission(true)).resolves.toBe(true);
    expect(getCurrentPosition).toHaveBeenCalledWith(expect.objectContaining({ enableHighAccuracy: true }));
  });

  // A coarse-only ("Approximate") grant does NOT satisfy a high-accuracy ask —
  // the user is routed to the probe to re-offer precise, instead of being pinned
  // to approximate forever by the fast path.
  it("does not fast-path a coarse-only grant when precise is requested", async () => {
    checkPermissions.mockResolvedValue(permission("denied", "granted"));
    getCurrentPosition.mockResolvedValue(position());
    await expect(ensureForegroundPermission(true)).resolves.toBe(true);
    expect(getCurrentPosition).toHaveBeenCalled();
  });

  // Discover ("races near me") only needs coarse: a coarse-only grant fast-paths
  // and never over-asks for precise.
  it("fast-paths a coarse-only grant when highAccuracy is false", async () => {
    checkPermissions.mockResolvedValue(permission("denied", "granted"));
    await expect(ensureForegroundPermission(false)).resolves.toBe(true);
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it("falls back to getCurrentPosition when checkPermissions rejects (location services off)", async () => {
    checkPermissions.mockRejectedValue(
      Object.assign(new Error("Location services are not enabled."), { code: "OS-PLUG-GLOC-0007" }),
    );
    getCurrentPosition.mockResolvedValue(position());
    await expect(ensureForegroundPermission()).resolves.toBe(true);
    expect(getCurrentPosition).toHaveBeenCalled();
  });

  it("falls back to getCurrentPosition when checkPermissions resolves not-granted", async () => {
    checkPermissions.mockResolvedValue(permission("denied"));
    getCurrentPosition.mockResolvedValue(position());
    await expect(ensureForegroundPermission()).resolves.toBe(true);
  });

  it("returns false (not a dead-end throw) when the fallback probe also fails", async () => {
    checkPermissions.mockRejectedValue(new Error("Location services are not enabled."));
    getCurrentPosition.mockRejectedValue(new Error("Request to enable location was denied."));
    await expect(ensureForegroundPermission()).resolves.toBe(false);
  });
});


// Tearing down a watch is fire-and-forget, and an uncaught rejection here is not
// cosmetic: ErrorBoundary listens for `unhandledrejection` and paints the
// full-screen crash overlay over a working app. `Geolocation.clearWatch` rejects
// with "WatchId not found." for any id that is no longer live — which PostHog
// recorded three times in one day, each moments after a live run started, i.e.
// exactly when the idle preview watch is cleared.
//
// Asserted as "a rejection handler is attached" rather than "no unhandled
// rejection fired": the runner's process reports the latter too late and too
// unreliably for a test, so it passes with the fix reverted. This assertion
// fails the moment the `.catch` goes.
describe("clearWatch teardown", () => {
  it("attaches a rejection handler for a watch that is already gone", () => {
    const onRejected = vi.fn().mockReturnThis();
    vi.mocked(Geolocation.clearWatch).mockReturnValue(
      { catch: onRejected } as unknown as Promise<void>);

    nativeSource.clearWatch({ id: "w1", removed: false, background: false });

    expect(Geolocation.clearWatch).toHaveBeenCalledWith({ id: "w1" });
    expect(onRejected).toHaveBeenCalledWith(expect.any(Function));
  });
});
