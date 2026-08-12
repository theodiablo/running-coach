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
const STALL_MS = 20000;

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

  it("keeps one retry chain when a disconnect and a failure race", async () => {
    // The disconnect callback and the rejected connect both want to reconnect.
    // Before single-flighting they each drove their own timer chain, which
    // doubled the shared backoff and doubled the scan rate.
    let onDisconnect: (() => void) | undefined;
    ble.client.connect.mockImplementation(async (_id, cb) => {
      onDisconnect = cb;
      cb();                                   // plugin reports the drop...
      throw new Error("connection timeout");  // ...and the call itself fails
    });
    bleSource.watch(vi.fn(), undefined, { deviceId: "d1" });
    await vi.advanceTimersByTimeAsync(120000);
    const attempts = ble.client.connect.mock.calls.length;
    expect(onDisconnect).toBeTypeOf("function");
    // One chain at the 15s cap over 2min is ~10 attempts; two chains would
    // roughly double it. Generous bound — this guards the order of magnitude.
    expect(attempts).toBeLessThan(16);
  });

  it("re-discovers at most once per scan-throttle window", async () => {
    ble.client.connect.mockRejectedValue(new Error("connection timeout"));
    bleSource.watch(vi.fn(), undefined, { deviceId: "d1", deviceName: "Polar H10" });
    await vi.advanceTimersByTimeAsync(90000);
    // Android allows ~5 scan starts per 30s; over 90s a per-attempt scan would
    // fire ~10 times and be throttled into uselessness.
    expect(ble.client.requestLEScan.mock.calls.length).toBeLessThanOrEqual(4);
    expect(ble.client.connect.mock.calls.length).toBeGreaterThan(4); // still retrying
  });

  it("forces a reconnect when a subscribed link goes silent", async () => {
    let notify: ((v: DataView) => void) | undefined;
    ble.client.startNotifications.mockImplementation(async (_id, _s, _c, cb) => { notify = cb; });
    const onSample = vi.fn();
    bleSource.watch(onSample, undefined, { deviceId: "d1" });
    await flush();
    expect(ble.client.disconnect).not.toHaveBeenCalled();
    notify!(hrView(140));
    await vi.advanceTimersByTimeAsync(15000); // still inside the stall window
    expect(ble.client.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15000); // 20s of silence since the sample
    expect(ble.client.disconnect).toHaveBeenCalledWith("d1");
    await vi.advanceTimersByTimeAsync(5000);
    expect(ble.client.startNotifications.mock.calls.length).toBeGreaterThan(1);
  });

  it("treats a 0bpm no-contact notification as a live link, not silence", async () => {
    // A strap off the body still notifies; parseHrMeasurement rejects 0bpm.
    // Counting that as silence would churn a reconnect every 20s at idle.
    let notify: ((v: DataView) => void) | undefined;
    ble.client.startNotifications.mockImplementation(async (_id, _s, _c, cb) => { notify = cb; });
    const onSample = vi.fn();
    bleSource.watch(onSample, undefined, { deviceId: "d1" });
    await flush();
    for (let i = 0; i < 30; i++) { notify!(hrView(0)); await vi.advanceTimersByTimeAsync(1000); }
    expect(onSample).not.toHaveBeenCalled();
    expect(ble.client.disconnect).not.toHaveBeenCalled();
  });

  it("re-arms instead of reconnecting when the watchdog fires late (frozen WebView)", async () => {
    // A backgrounded Android WebView freezes timers AND notification callbacks,
    // so an overdue watchdog says nothing about the link. Acting on it would
    // tear down a healthy sensor on resume.
    let notify: ((v: DataView) => void) | undefined;
    ble.client.startNotifications.mockImplementation(async (_id, _s, _c, cb) => { notify = cb; });
    bleSource.watch(vi.fn(), undefined, { deviceId: "d1" });
    await flush();
    notify!(hrView(150));
    // Freeze: no timers run, then everything fires at once far past its deadline.
    vi.setSystemTime(Date.now() + 300000);
    await vi.advanceTimersByTimeAsync(STALL_MS + 1000);
    expect(ble.client.disconnect).not.toHaveBeenCalled(); // grace, not a teardown
    notify!(hrView(151));                                 // link was fine all along
    await vi.advanceTimersByTimeAsync(15000);
    expect(ble.client.disconnect).not.toHaveBeenCalled();
  });

  it("a live stream is never interrupted by the watchdog", async () => {
    let notify: ((v: DataView) => void) | undefined;
    ble.client.startNotifications.mockImplementation(async (_id, _s, _c, cb) => { notify = cb; });
    bleSource.watch(vi.fn(), undefined, { deviceId: "d1" });
    await flush();
    for (let i = 0; i < 60; i++) { notify!(hrView(150)); await vi.advanceTimersByTimeAsync(1000); }
    expect(ble.client.disconnect).not.toHaveBeenCalled();
    expect(ble.client.connect).toHaveBeenCalledTimes(1);
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

  it("cancels a pending retry so a cleared watch never reconnects", async () => {
    ble.client.connect.mockRejectedValue(new Error("connection timeout"));
    const handle = bleSource.watch(vi.fn(), undefined, { deviceId: "d1" });
    await flush();
    await bleSource.clearWatch(handle);
    const attempts = ble.client.connect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(ble.client.connect.mock.calls.length).toBe(attempts);
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
