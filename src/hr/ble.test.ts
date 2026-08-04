import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Controllable fake of the plugin client. Module state in ble.ts (init flag,
// current watch, teardown chain) is reset per test via resetModules + dynamic
// import; the client object itself is shared and re-primed in beforeEach.
const ble = vi.hoisted(() => ({
  client: {
    initialize: vi.fn(),
    isEnabled: vi.fn(),
    getDevices: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    startNotifications: vi.fn(),
    stopNotifications: vi.fn(),
    requestLEScan: vi.fn(),
    stopLEScan: vi.fn(),
  },
}));
vi.mock("@capacitor-community/bluetooth-le", () => ({
  BleClient: ble.client,
  numberToUUID: (n: number) => `uuid-${n.toString(16)}`,
}));

type Source = typeof import("./ble").bleSource;
let bleSource: Source;

// Standard HR measurement: flags byte 0 (uint8 bpm), then the bpm.
const hrView = (bpm: number) => new DataView(new Uint8Array([0, bpm]).buffer);

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(async () => {
  vi.useFakeTimers();
  for (const fn of Object.values(ble.client)) fn.mockReset().mockResolvedValue(undefined);
  ble.client.getDevices.mockResolvedValue([]);
  vi.resetModules();
  ({ bleSource } = await import("./ble"));
});
afterEach(() => { vi.useRealTimers(); });

describe("bleSource.watch", () => {
  it("connects, subscribes, and streams parsed samples", async () => {
    let notify: ((v: DataView) => void) | undefined;
    ble.client.startNotifications.mockImplementation(async (_id, _s, _c, cb) => { notify = cb; });
    const onSample = vi.fn();
    bleSource.watch(onSample, undefined, { deviceId: "d1" });
    await flush();
    expect(ble.client.connect).toHaveBeenCalledWith("d1", expect.any(Function));
    notify!(hrView(72));
    expect(onSample).toHaveBeenCalledWith({ bpm: 72, t: expect.any(Number) });
  });

  it("reports no-device without touching the client", async () => {
    const onErr = vi.fn();
    bleSource.watch(vi.fn(), onErr, {});
    await flush();
    expect(onErr).toHaveBeenCalled();
    expect(ble.client.connect).not.toHaveBeenCalled();
  });

  it("re-runs initialize on retry after a failed first init", async () => {
    ble.client.initialize.mockRejectedValueOnce(new Error("adapter off"));
    const onErr = vi.fn();
    bleSource.watch(vi.fn(), onErr, { deviceId: "d1" });
    await flush();
    expect(onErr).toHaveBeenCalled();
    expect(ble.client.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30000); // covers backoff + the re-discovery scan window
    expect(ble.client.initialize.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(ble.client.connect).toHaveBeenCalled();
  });

  it("re-discovers a rotated address by name and persists it", async () => {
    ble.client.connect.mockRejectedValueOnce(new Error("connection timeout"));
    ble.client.requestLEScan.mockImplementation(async (_opts, cb) => {
      cb({ device: { deviceId: "NEW", name: "Polar H10" } });
    });
    const onDeviceChange = vi.fn();
    bleSource.watch(vi.fn(), undefined, { deviceId: "OLD", deviceName: "Polar H10", onDeviceChange });
    await vi.advanceTimersByTimeAsync(30000);
    expect(onDeviceChange).toHaveBeenCalledWith({ id: "NEW", name: "Polar H10" });
    expect(ble.client.connect).toHaveBeenLastCalledWith("NEW", expect.any(Function));
  });

  it("ignores scan results for other sensors", async () => {
    ble.client.connect.mockRejectedValue(new Error("connection timeout"));
    ble.client.requestLEScan.mockImplementation(async (_opts, cb) => {
      cb({ device: { deviceId: "OTHER", name: "Someone else's strap" } });
    });
    const onDeviceChange = vi.fn();
    bleSource.watch(vi.fn(), undefined, { deviceId: "OLD", deviceName: "Polar H10", onDeviceChange });
    await vi.advanceTimersByTimeAsync(60000);
    expect(onDeviceChange).not.toHaveBeenCalled();
    expect(ble.client.connect).toHaveBeenLastCalledWith("OLD", expect.any(Function));
  });

  it("reports unreachable only after repeated failed cycles, and keeps retrying", async () => {
    ble.client.connect.mockRejectedValue(new Error("connection timeout"));
    const onStatus = vi.fn();
    bleSource.watch(vi.fn(), undefined, { deviceId: "d1", onStatus });
    await flush();
    expect(onStatus).not.toHaveBeenCalledWith("unreachable");
    await vi.advanceTimersByTimeAsync(60000);
    expect(onStatus).toHaveBeenCalledWith("unreachable");
    const attempts = ble.client.connect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(ble.client.connect.mock.calls.length).toBeGreaterThan(attempts);
  });

  it("reconnects after an unsolicited disconnect", async () => {
    let onDisconnect: (() => void) | undefined;
    ble.client.connect.mockImplementation(async (_id, cb) => { onDisconnect = cb; });
    bleSource.watch(vi.fn(), undefined, { deviceId: "d1" });
    await flush();
    expect(ble.client.startNotifications).toHaveBeenCalledTimes(1);
    onDisconnect!();
    await vi.advanceTimersByTimeAsync(2000);
    expect(ble.client.startNotifications).toHaveBeenCalledTimes(2);
  });
});

describe("bleSource.clearWatch", () => {
  it("stops notifications and disconnects", async () => {
    const handle = bleSource.watch(vi.fn(), undefined, { deviceId: "d1" });
    await flush();
    await bleSource.clearWatch(handle);
    expect(ble.client.stopNotifications).toHaveBeenCalled();
    expect(ble.client.disconnect).toHaveBeenCalledWith("d1");
  });

  it("disconnects a connection established after the watch was stopped", async () => {
    let resolveConnect!: () => void;
    ble.client.connect.mockReturnValueOnce(new Promise<void>((res) => { resolveConnect = res; }));
    const handle = bleSource.watch(vi.fn(), undefined, { deviceId: "d1" });
    await flush();
    const cleared = bleSource.clearWatch(handle);
    resolveConnect(); // connect lands after stop → must not stay connected
    await flush();
    await cleared;
    expect(ble.client.startNotifications).not.toHaveBeenCalled();
    expect(ble.client.disconnect).toHaveBeenCalledWith("d1");
  });

  it("a stopped watch's late connect never disconnects its successor", async () => {
    let resolveConnectA!: () => void;
    ble.client.connect.mockReturnValueOnce(new Promise<void>((res) => { resolveConnectA = res; }));
    const a = bleSource.watch(vi.fn(), undefined, { deviceId: "d1" });
    await flush();
    void bleSource.clearWatch(a);            // teardown queued while A's connect hangs
    bleSource.watch(vi.fn(), undefined, { deviceId: "d1" }); // successor claims the sensor
    await flush();
    expect(ble.client.startNotifications).toHaveBeenCalledTimes(1); // B is live
    const disconnects = ble.client.disconnect.mock.calls.length;
    resolveConnectA(); // A's connect finally lands, but B owns the sensor now
    await flush();
    expect(ble.client.disconnect.mock.calls.length).toBe(disconnects);
  });

  it("a successor's connect waits out the previous teardown", async () => {
    let resolveStopNotif!: () => void;
    const a = bleSource.watch(vi.fn(), undefined, { deviceId: "d1" });
    await flush();
    ble.client.stopNotifications.mockReturnValueOnce(new Promise<void>((res) => { resolveStopNotif = res; }));
    void bleSource.clearWatch(a);            // teardown in flight...
    bleSource.watch(vi.fn(), undefined, { deviceId: "d1" });
    await flush();
    expect(ble.client.connect).toHaveBeenCalledTimes(1); // B has NOT connected yet
    resolveStopNotif();
    await flush();
    expect(ble.client.connect).toHaveBeenCalledTimes(2); // ...then B connects
    const order = {
      teardownDisconnect: ble.client.disconnect.mock.invocationCallOrder[0],
      successorConnect: ble.client.connect.mock.invocationCallOrder[1],
    };
    expect(order.teardownDisconnect).toBeLessThan(order.successorConnect);
  });
});
