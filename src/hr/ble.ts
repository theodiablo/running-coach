import { BleClient, numberToUUID } from "@capacitor-community/bluetooth-le";
import { parseHrMeasurement } from "../utils/hr";
import { logTrack } from "../geo/trackLog";
import { lastNativeHrBeatAt } from "./hrJournal";

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
// Android rate-limits an app to ~5 LE scan starts per 30s window, after which
// every scan silently returns nothing. A reconnect loop that scans on each
// attempt burns that allowance in seconds and then cannot find the sensor at
// all, so re-discovery gets its own floor and cheap direct connects run between.
const SCAN_MIN_INTERVAL_MS = 30000;
// A GATT link can sit nominally "connected" while notifications stop arriving.
// The sensor notifies at ~1-2Hz, so this much silence is a dead link, not a
// gap — drop it and reconnect instead of recording nothing for the rest of a run.
// Silence here means the NATIVE callback went quiet, not that this JS stopped
// hearing about it: see onStall.
const STALL_MS = 20000;
// How late the watchdog may fire and still be believed. A backgrounded Android
// WebView freezes its timers and its notification callbacks alike, so on resume
// an overdue timer means "we were frozen", not "the sensor stopped" — and acting
// on it would tear down a healthy link (and with it the native journal that was
// covering us). Past this much lateness the watchdog re-arms instead.
const STALL_GRACE_MS = 5000;
// How long a RECONNECT may take before we call it failed. The plugin defaults to
// 10s, which is shorter than the window Android's own direct connect uses to
// look for the peripheral (~30s) — so a strap that dropped and is advertising
// again on its slow interval was being given up on while the platform was still
// finding it. Each of those premature failures then set scanFirst, spending a
// re-discovery scan out of Android's small allowance to do what the connect
// would have done for free. The first attempt keeps the plugin default: it runs
// during the idle preview, where the sensor is in the runner's hands and quick
// "can't reach sensor" feedback is worth more than patience.
const RECONNECT_TIMEOUT_MS = 30000;
// Android's background-connection mode (patched into the plugin): the stack
// holds the request and completes it the moment the strap advertises again, with
// NO app-side scan — the one recovery Android's scan throttle cannot take away.
// It is alternated with, never substituted for, the scan cycle: autoConnect aims
// at a saved address, so a sensor whose resolvable private address has rotated
// would wait on an address that will never advertise again, and only the
// name-matching re-discovery gets it back.
//
// The deadline is NOT optional and must never become "unbounded". An autoConnect
// that never completes delivers no callback at all, so this timeout is its only
// cancel; and every BleClient call shares one JS queue, so a connect left in
// flight blocks our own teardown, the next watch's connect, and the pairing
// screen's scan. This value is therefore three things at once: how patient we
// are, how long rotation recovery is delayed, and how long after Finish a
// stopped watch can still hold the radio.
const AUTO_CONNECT_TIMEOUT_MS = 45000;
// How long a down link may stay "connecting…" before the runner is told the
// truth. Two failed cycles used to be the whole verdict and arrived in under a
// minute; with a patient autoConnect cycle in the rotation that alone would take
// minutes, leaving a dead strap reading "connecting" the whole time.
const UNREACHABLE_AFTER_MS = 45000;
// Notifications land at ~1-2Hz; one diagnostic row each would fill the ring
// buffer with a few minutes of a run. Roll them up instead — what the log has to
// answer is whether beats were arriving at all across a stretch, not their values.
const BEAT_LOG_MS = 15000;

export type BleDevice = { id: string; name: string };
export type BleHrSample = { bpm: number; t: number };
// `dispose` cancels the watch's own timers (retry, stall watchdog); clearWatch
// calls it. Internal to watch() — callers only ever pass the handle back.
export type BleWatchHandle = { deviceId?: string; stopped: boolean; dispose?: () => void };
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

// A plugin rejection is sometimes an Error, sometimes a bare string, sometimes a
// {message} bag — and the distinction between "Connection timeout." and a GATT
// 133 is the whole point of logging it, so don't flatten it to "failed".
const errText = (error: unknown): string => {
  if (!error) return "failed";
  if (typeof error === "string") return error;
  const msg = (error as { message?: unknown }).message;
  return typeof msg === "string" && msg ? msg : "failed";
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
    let lastScanAt = 0;    // epoch ms of the last re-discovery scan (SCAN_MIN_INTERVAL_MS floor)
    // Exactly one attempt in flight. A disconnect callback and a failed attempt
    // both want to reconnect, and each used to spawn its own timer chain: the
    // chains shared one backoff (so it hit the cap immediately), each ran its own
    // re-discovery scan, and together they tripped Android's scan throttle — the
    // sensor then stayed unreachable for minutes at a time mid-run.
    let attempting = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let stallArmedAt = 0;  // when the watchdog was set, to tell lateness from silence
    let lastStatus: BleWatchStatus | null = null; // log a status only when it changes
    let attempts = 0;      // connect attempts made by this watch (1 = the first)
    let autoNext = false;  // alternate an autoConnect cycle with a scan+direct one
    let downSince = 0;     // epoch ms the link was first known down (0 = up)
    // Beat roll-up for the diagnostic log (see BEAT_LOG_MS).
    let beatsSinceLog = 0;
    let beatLogAt = 0;
    // True while forceReconnect is tearing the link down, so the disconnect it
    // causes is logged as ours rather than as the sensor dropping out.
    let selfDisconnecting = false;
    // Either evidence is enough: two full cycles, or simply long enough down.
    const downStatus = (): BleWatchStatus =>
      failures >= 2 || (downSince > 0 && Date.now() - downSince >= UNREACHABLE_AFTER_MS)
        ? "unreachable" : "connecting";

    const status = (s: BleWatchStatus) => {
      if (handle.stopped) return;
      if (s !== lastStatus) { lastStatus = s; logTrack("hr-status", { msg: s }); }
      onStatus?.(s);
    };

    // Direct connect only reaches a peripheral Android has recently seen
    // advertise, and a sensor using resolvable private addresses invalidates the
    // saved id outright once it rotates — "worked right after pairing, then never
    // again". A short HR-filtered scan refreshes the OS cache and follows a
    // rotation by matching the saved name; a changed id is reported via
    // onDeviceChange so the caller can persist it.
    const rediscover = () => new Promise<void>((resolve) => {
      status("scanning");
      logTrack("hr-scan", { msg: "start" });
      let settled = false;
      let found = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        logTrack("hr-scan", { msg: found ? "found" : "none", ok: found });
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
        found = true;
        finish();
      }).then(() => { timer = setTimeout(finish, REDISCOVER_SCAN_MS); })
        .catch(finish);
    });

    // Cancel and re-arm the silence watchdog. Called on every sample, so a live
    // link never fires it; a subscribed link that goes quiet does.
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = undefined;
      if (handle.stopped) return;
      stallArmedAt = Date.now();
      stallTimer = setTimeout(onStall, STALL_MS);
    };

    const onStall = () => {
      stallTimer = undefined;
      if (handle.stopped) return;
      // Fired far later than it was set for → the WebView was frozen, which
      // silences the notification callback too, so this proves nothing about the
      // link. Give it one clean window instead: a healthy sensor lands a sample
      // within ~1s of the WebView waking and disarms this before it fires again.
      if (Date.now() - stallArmedAt > STALL_MS + STALL_GRACE_MS) {
        logTrack("hr-stall", { msg: "late-fire", sinceMs: Date.now() - stallArmedAt });
        armStall();
        return;
      }
      // Silence in THIS stream is not silence on the link: the GATT callback
      // keeps firing while delivery to the WebView stalls, so ask it before
      // tearing anything down (docs/health-integrations.md). Null — iOS, an
      // unpatched shell, no beat yet — keeps the original behaviour.
      void lastNativeHrBeatAt().then(beatAt => {
        if (handle.stopped || stallTimer) return; // a sample landed meanwhile
        const nativeAge = beatAt != null ? Date.now() - beatAt : undefined;
        if (beatAt != null && Date.now() - beatAt < STALL_MS) {
          // The link is fine and it is delivery to this WebView that stopped.
          logTrack("hr-stall", { msg: "delivery-stall", sinceMs: nativeAge });
          armStall();
          return;
        }
        logTrack("hr-stall", { msg: beatAt == null ? "silent (no native beat)" : "link-dead", sinceMs: nativeAge });
        forceReconnect();
      });
    };

    // Tear the link down and reconnect. The sensor is still notifying into a
    // socket nothing is listening on, so a plain retry would be refused as
    // "already connected" — the disconnect has to happen first.
    const forceReconnect = () => {
      if (handle.stopped || attempting) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = undefined;
      status(downStatus());
      selfDisconnecting = true;
      const id = handle.deviceId;
      // Our own disconnect may fire onDisconnected, which schedules a retry too;
      // scheduleRetry is single-flight, so whichever lands first wins.
      const done = () => { selfDisconnecting = false; scheduleRetry(); };
      if (!id) { done(); return; }
      (async () => {
        try { await BleClient.stopNotifications(id, HR_SERVICE, HR_MEASUREMENT); } catch { /* ignore */ }
        try { await BleClient.disconnect(id); } catch { /* ignore */ }
      })().then(done, done);
    };

    const onDisconnected = () => {
      if (handle.stopped) return;
      logTrack("hr-connect", { ok: false, msg: selfDisconnecting ? "disconnected (watchdog teardown)" : "disconnected by peer" });
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = undefined;
      if (!downSince) downSince = Date.now();
      status(downStatus());
      scheduleRetry();
    };

    const start = async () => {
      // Re-run init every attempt: a failed first initialize (adapter off,
      // permission mid-prompt) must not wedge the watch for its whole lifetime.
      await ensureInit();
      // Only re-discover when the scan allowance has recovered; otherwise fall
      // through to a direct connect, which costs nothing and often works once
      // the sensor has advertised again.
      if (scanFirst && !autoNext) {
        if (Date.now() - lastScanAt >= SCAN_MIN_INTERVAL_MS) {
          lastScanAt = Date.now();
          await rediscover();
          scanFirst = false;
        } else {
          logTrack("hr-scan", { msg: "throttled", sinceMs: Date.now() - lastScanAt });
        }
      }
      if (handle.stopped) return;
      status(downStatus());
      const id = handle.deviceId!;
      // iOS cold-launch gotcha: CoreBluetooth can only connect to a peripheral
      // this app session has *retrieved* — a deviceId saved on a previous
      // launch must be re-materialized via getDevices() first or connect()
      // rejects with "device not found". No-op when the device is already
      // known (post-scan, or Android); real failures still surface in connect.
      try { await BleClient.getDevices([id]); } catch { /* connect() reports the actionable error */ }
      attempts += 1;
      logTrack("hr-connect", { msg: `attempt ${attempts}${attempts === 1 ? "" : autoNext ? " (auto)" : " (direct)"}` });
      if (attempts === 1) await BleClient.connect(id, onDisconnected);
      else if (autoNext) await BleClient.connect(id, onDisconnected,
        { timeout: AUTO_CONNECT_TIMEOUT_MS, autoConnect: true });
      else await BleClient.connect(id, onDisconnected, { timeout: RECONNECT_TIMEOUT_MS });
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
        // Re-arm on ANY notification, before the parse: a strap off the body
        // keeps notifying 0bpm, which parses to null, and treating that as
        // silence would churn a reconnect every STALL_MS while the record
        // screen sits idle. The watchdog watches the link, not the reading.
        armStall();
        const parsed = parseHrMeasurement(value);
        if (parsed) onSample({ bpm: parsed.bpm, t: Date.now() });
        // Roll-up, not per-beat: the question the log answers is whether beats
        // were being DELIVERED here across a stretch, not what they read.
        beatsSinceLog += 1;
        const now = Date.now();
        if (!beatLogAt) beatLogAt = now; // first beat of the watch — start the window
        else if (now - beatLogAt >= BEAT_LOG_MS) {
          logTrack("hr-beat", { n: beatsSinceLog, bpm: parsed?.bpm, sinceMs: now - beatLogAt });
          beatsSinceLog = 0;
          beatLogAt = now;
        }
      });
      backoff = 1000; failures = 0; downSince = 0; // reset after a clean (re)connect
      logTrack("hr-connect", { ok: true, msg: `attempt ${attempts}` });
      status("connected");
      armStall(); // subscribed but not yet notifying — the watchdog owns it from here
    };
    const onFail = (error?: unknown) => {
      attempting = false;
      if (handle.stopped) return;
      logTrack("hr-connect", { ok: false, msg: `attempt ${attempts}: ${errText(error)}` });
      scanFirst = true;
      autoNext = !autoNext; // next cycle takes the other route
      failures += 1;
      if (!downSince) downSince = Date.now();
      status(downStatus()); // one slow strap isn't a verdict; two cycles or 45s are
      backoff = Math.min(backoff * 2, RETRY_MAX_MS);
      scheduleRetry();
    };
    // Single-flight: a second caller while an attempt is scheduled or running is
    // a no-op, so the reconnect path can never fan out into competing chains.
    const scheduleRetry = () => {
      if (handle.stopped || attempting) return;
      attempting = true;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (handle.stopped) { attempting = false; return; }
        start().then(() => { attempting = false; }, onFail);
      }, backoff);
    };
    handle.dispose = () => {
      if (retryTimer) clearTimeout(retryTimer);
      if (stallTimer) clearTimeout(stallTimer);
      retryTimer = stallTimer = undefined;
    };
    attempting = true;
    (async () => {
      // Wait out any previous watch's teardown so its disconnect can't land on
      // (and kill) the connection this watch is about to open.
      await teardownChain.catch(() => { /* previous teardown failed — proceed */ });
      if (handle.stopped) { attempting = false; return; }
      try { await start(); attempting = false; }
      catch (e) { onErr?.(e); onFail(e); }
    })();
    return handle;
  },

  async clearWatch(handle?: BleWatchHandle | null) {
    if (!handle) return;
    handle.stopped = true;
    handle.dispose?.();
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
