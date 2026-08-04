import { BleClient, numberToUUID } from "@capacitor-community/bluetooth-le";
import { parseHrMeasurement } from "../utils/hr";

// Live heart-rate source: a standard Bluetooth LE Heart Rate sensor (chest strap,
// optical armband, or a watch broadcasting over the Heart Rate Profile — e.g.
// Amazfit "Heart Rate Push"). Implements the LiveHrSource contract consumed by
// useRunTracker (isAvailable / scan / requestPermissions / watch / clearWatch),
// the HR analogue of geoSource. Selected only in the native shell (see source.js);
// the @capacitor-community/bluetooth-le JS is bundled but never executed on web.
//
// Standard GATT Heart Rate Profile: service 0x180D, measurement char 0x2A37.
const HR_SERVICE = numberToUUID(0x180d);
const HR_MEASUREMENT = numberToUUID(0x2a37);

const RETRY_MAX_MS = 15000;      // reconnect backoff cap
const REDISCOVER_SCAN_MS = 6000; // how long a re-discovery scan listens before giving up

export type BleDevice = { id: string; name: string };
export type BleHrSample = { bpm: number; t: number };
export type BleWatchHandle = { deviceId?: string; stopped: boolean };
// "unreachable" = a full connect + re-discovery cycle failed (the watch keeps
// retrying); everything before that is some flavour of still-trying.
export type BleWatchStatus = "connecting" | "scanning" | "connected" | "unreachable";
type BleWatchOptions = {
  deviceId?: string;
  // Saved name of the paired sensor — the stable identity used to re-discover a
  // device whose Bluetooth address rotated (see rediscover in watch()).
  deviceName?: string;
  // Fired when re-discovery lands on a new address for the same sensor, so the
  // caller can persist it and the next session connects directly again.
  onDeviceChange?: (device: BleDevice) => void;
  onStatus?: (status: BleWatchStatus) => void;
};

let initialized = false;
async function ensureInit() {
  if (!initialized) {
    // androidNeverForLocation: pair with the BLUETOOTH_SCAN neverForLocation flag
    // in the manifest so scanning never implies location access.
    await BleClient.initialize({ androidNeverForLocation: true });
    initialized = true;
  }
}

// The newest watch for each open/close of the tracker. A stopped watch consults
// this before issuing a late disconnect so it can never tear down a successor's
// fresh connection to the same sensor.
let currentWatch: BleWatchHandle | null = null;
// Teardowns chain here, and a new watch's first connect awaits the chain: the
// plugin serializes every call through one global queue, so without this a
// closing watch's in-flight disconnect could land AFTER the next watch's
// connect and silently kill it (record screen closed and re-opened quickly).
let teardownChain: Promise<void> = Promise.resolve();

const bleSourceImpl = {
  id: "bluetooth" as const,
  live: true as const,

  // True only when BLE is usable (initialized + adapter on). Never throws.
  async isAvailable() {
    try { await ensureInit(); return await BleClient.isEnabled(); }
    catch { return false; }
  },

  // Scan for HR-profile peripherals for `ms`, reporting each unique device as
  // {id,name} via onDevice. Resolves when the scan window ends. Initializing /
  // scanning triggers the Android 12+ BLUETOOTH_SCAN/CONNECT runtime prompt.
  async scan(onDevice: (device: BleDevice) => void, ms = 8000) {
    await ensureInit();
    const seen = new Set();
    await BleClient.requestLEScan({ services: [HR_SERVICE] }, (result) => {
      const id = result.device.deviceId;
      if (seen.has(id)) return;
      seen.add(id);
      onDevice({ id, name: result.device.name || result.localName || "Heart-rate sensor" });
    });
    await new Promise((resolve) => setTimeout(resolve, ms));
    try { await BleClient.stopLEScan(); } catch { /* already stopped — ignore */ }
  },

  // Surface the OS Bluetooth permission prompt (via initialize) ahead of a run.
  async requestPermissions() {
    try { await ensureInit(); return true; }
    catch { return false; }
  },

  // Connect to the paired deviceId and stream { bpm, t } samples to onSample.
  // Auto-reconnects with capped backoff on an unsolicited disconnect so a strap
  // dropping mid-run doesn't end HR capture. Returns a handle for clearWatch.
  watch(onSample: (sample: BleHrSample) => void, onErr?: (error: unknown) => void,
    { deviceId, deviceName, onDeviceChange, onStatus }: BleWatchOptions = {}) {
    const handle: BleWatchHandle = { deviceId, stopped: false };
    if (!deviceId) { onErr?.(new Error("No heart-rate sensor paired.")); return handle; }
    currentWatch = handle;
    let backoff = 1000;
    let failures = 0;      // consecutive failed attempts since the last clean connect
    let scanFirst = false; // a direct connect failed → re-discover before the next attempt
    const status = (s: BleWatchStatus) => { if (!handle.stopped) onStatus?.(s); };

    // Direct connect only reaches a peripheral Android has recently seen
    // advertise, and a sensor using resolvable private addresses invalidates the
    // saved id outright once it rotates — "worked right after pairing, then never
    // again". A short HR-filtered scan refreshes the OS cache and follows a
    // rotation by matching the saved name; a changed id is reported via
    // onDeviceChange so the caller can persist it.
    const rediscover = () => new Promise<void>((resolve) => {
      status("scanning");
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        BleClient.stopLEScan().catch(() => { /* not scanning — ignore */ });
        resolve();
      };
      BleClient.requestLEScan({ services: [HR_SERVICE] }, (result) => {
        if (handle.stopped) { finish(); return; }
        const id = result.device.deviceId;
        const name = result.device.name || result.localName || "";
        if (id !== handle.deviceId && (!deviceName || name !== deviceName)) return;
        if (id !== handle.deviceId) {
          handle.deviceId = id;
          onDeviceChange?.({ id, name: name || deviceName || "Heart-rate sensor" });
        }
        finish();
      }).then(() => { timer = setTimeout(finish, REDISCOVER_SCAN_MS); })
        .catch(finish);
    });

    const start = async () => {
      // Re-run init every attempt: a failed first initialize (adapter off,
      // permission mid-prompt) must not wedge the watch for its whole lifetime.
      await ensureInit();
      if (scanFirst) { await rediscover(); scanFirst = false; }
      if (handle.stopped) return;
      status("connecting");
      const id = handle.deviceId!;
      // iOS cold-launch gotcha: CoreBluetooth can only connect to a peripheral
      // this app session has *retrieved* — a deviceId saved on a previous
      // launch must be re-materialized via getDevices() first or connect()
      // rejects with "device not found". No-op when the device is already
      // known (post-scan, or Android); real failures still surface in connect.
      try { await BleClient.getDevices([id]); } catch { /* connect() reports the actionable error */ }
      await BleClient.connect(id, () => { if (!handle.stopped) { status("connecting"); retry(); } });
      // clearWatch may have run while connect() was in flight (e.g. the run was
      // discarded/finished before a slow/out-of-range sensor finished connecting).
      // Don't subscribe to a device we were told to stop watching — disconnect
      // instead, so a stopped watch can never leave a live BLE connection (and
      // its notification stream) running in the background. Unless a NEWER watch
      // has since claimed this sensor: the connection is now theirs — leave it.
      if (handle.stopped) {
        const successor = currentWatch && currentWatch !== handle && currentWatch.deviceId === id;
        if (!successor) { try { await BleClient.disconnect(id); } catch { /* ignore */ } }
        return;
      }
      await BleClient.startNotifications(id, HR_SERVICE, HR_MEASUREMENT, (value) => {
        const parsed = parseHrMeasurement(value);
        if (parsed) onSample({ bpm: parsed.bpm, t: Date.now() });
      });
      backoff = 1000; failures = 0; // reset after a clean (re)connect
      status("connected");
    };
    const onFail = () => {
      if (handle.stopped) return;
      scanFirst = true;
      failures += 1;
      if (failures >= 2) status("unreachable"); // one slow strap isn't a verdict; two full cycles are
      backoff = Math.min(backoff * 2, RETRY_MAX_MS);
      retry();
    };
    const retry = () => {
      if (handle.stopped) return;
      setTimeout(() => {
        if (handle.stopped) return;
        start().catch(onFail);
      }, backoff);
    };
    (async () => {
      // Wait out any previous watch's teardown so its disconnect can't land on
      // (and kill) the connection this watch is about to open.
      await teardownChain.catch(() => { /* previous teardown failed — proceed */ });
      if (handle.stopped) return;
      try { await start(); }
      catch (e) { onErr?.(e); onFail(); }
    })();
    return handle;
  },

  async clearWatch(handle?: BleWatchHandle | null) {
    if (!handle) return;
    handle.stopped = true;
    if (currentWatch === handle) currentWatch = null;
    const { deviceId } = handle;
    if (!deviceId) return;
    const teardown = async () => {
      try { await BleClient.stopNotifications(deviceId, HR_SERVICE, HR_MEASUREMENT); } catch { /* ignore */ }
      try { await BleClient.disconnect(deviceId); } catch { /* ignore */ }
    };
    teardownChain = teardownChain.then(teardown, teardown);
    await teardownChain;
  },
};

export const bleSource = bleSourceImpl as typeof bleSourceImpl & { fetchRange?: never };
