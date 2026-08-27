import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Bluetooth, Watch, Loader, Check, RefreshCw, Trash2, ChevronDown, Smartphone } from "lucide-react";
import { isNative, isAndroid } from "../native";
import { bleSource } from "../hr/ble";
import { healthConnectSource } from "../hr/healthconnect";
import { healthKitSource } from "../hr/healthkit";
import { connectHealthConnect } from "../health/connect";
import { getPairedDevice, setPairedDevice, forgetPairedDevice } from "../hr/device";
import { HrSensorDisclosure } from "../modals/HrSensorDisclosure";
import { importProviders, healthStoreProviderIds, providerEnabledInSettings } from "../imports/registry";
import { isWatchDebugEnabled, setWatchDebug } from "../watch/scanLog";
import { fileShellReport } from "../diag/shellLog";
import { setGeoDebug } from "../geo/trackLog";
import { WatchSyncLog } from "./WatchSyncLog";
import { TrackDiagLog } from "./TrackDiagLog";
import { BetaBadge } from "../components/BetaBadge";
import { ToggleSwitch } from "../components/ToggleSwitch";
import { HR_BLE_DISCLOSED_KEY, PLAY_STORE_BETA_URL, APP_STORE_URL, TESTFLIGHT_BETA_URL } from "../constants";
import type { ImportProvider } from "../imports/types";
import type { HrMethod, SettingsState } from "../types";

// ── Connections & sync ──────────────────────────────────────────────────────
// The ONE settings card for every external source feeding runs or heart rate:
// BLE HR sensor row, one health-store row (Health Connect/Apple Health, current
// platform only) with per-feature sub-toggles, and cloud provider rows. Web
// collapses native-only rows into an "in the mobile app" pointer instead of
// disabled controls. Presentation merge only — settings keys are unchanged.

type ConnectionsProps = {
  settings: SettingsState;
  saveSettings: (settings: SettingsState) => void;
  showToast?: (msg: string, type?: string) => void;
  // Manual wider-window scan across all providers — returns how many runs it found.
  scanImportsNow?: () => Promise<number>;
};

// Where is a provider's synced enable-flag? The health-store providers share
// settings.watchImport — one platform-neutral "import from my phone's health
// store" preference (don't churn the synced blob); anything newer lands in the
// settings.imports map. The read side is providerEnabledInSettings
// (registry.ts), shared with the scan gate in RunningCoach so the two can't drift.
type ImportsFlags = Record<string, boolean>;
function withProviderEnabled(settings: SettingsState, id: string, on: boolean): SettingsState {
  if (healthStoreProviderIds.has(id)) return { ...settings, watchImport: on };
  return { ...settings, imports: { ...(settings.imports as ImportsFlags | undefined), [id]: on } };
}

// Collapsible help: settings should configure, not lecture — the long
// explanations (and the beta caveat) live behind this tap instead of
// permanently occupying screens of scroll. Exported for the vendor guides on
// the Integrations page, which are the same "tap to read, otherwise stay out of
// the way" shape.
//
// `label` is REQUIRED, and must name what it explains ("How Polar works", not
// "How it works"). This page stacks several of these a few pixels apart — one
// per connection row plus the card's own — and identically-labelled neighbours
// are unreadable: you cannot tell which disclosure answers which row.
export function HowItWorks({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-300">
        <ChevronDown size={13} className={"transition-transform " + (open ? "rotate-180" : "")} />
        {label}
      </button>
      {open && <div className="mt-2 space-y-2 text-xs text-slate-500">{children}</div>}
    </div>
  );
}

function RowShell({ icon, label, status, control }: { icon: React.ReactNode; label: string; status?: string; control?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="text-orange-400 shrink-0">{icon}</span>
        <div className="min-w-0">
          <p className="text-sm text-slate-200">{label}</p>
          {status && <p className="text-xs text-slate-500 truncate">{status}</p>}
        </div>
      </div>
      {control}
    </div>
  );
}

// ── Bluetooth heart-rate sensor (live HR during runs) ───────────────────────
function BleRow({ settings, saveSettings, showToast }: ConnectionsProps) {
  const { t } = useTranslation();
  const [paired, setPaired] = useState(() => getPairedDevice());
  const [setupOpen, setSetupOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<{ id: string; name: string }[]>([]);
  const [showDisclosure, setShowDisclosure] = useState(false);
  const on = settings.hrMethod === "bluetooth" && !!paired;

  const setMethod = (m: HrMethod) => saveSettings({ ...settings, hrMethod: m });

  const disclosed = () => {
    try { return localStorage.getItem(HR_BLE_DISCLOSED_KEY) === "1"; } catch { return false; }
  };
  const markDisclosed = () => {
    try { localStorage.setItem(HR_BLE_DISCLOSED_KEY, "1"); } catch { /* quota — non-fatal */ }
  };

  const runScan = async () => {
    setFound([]);
    setScanning(true);
    try {
      await bleSource.scan((d: { id: string; name: string }) =>
        setFound(prev => prev.some(x => x.id === d.id) ? prev : [...prev, d]));
    } catch {
      showToast?.(t("settings.hrSensor.scanFailed"), "err");
    }
    setScanning(false);
  };
  // Gate the first scan behind the prominent disclosure + OS Bluetooth prompt.
  const startScan = () => { if (disclosed()) runScan(); else setShowDisclosure(true); };
  const acceptDisclosure = async () => {
    setShowDisclosure(false);
    const ok = await bleSource.requestPermissions();
    if (!ok) { showToast?.(t("settings.hrSensor.permissionNeeded"), "err"); return; }
    markDisclosed();
    runScan();
  };

  const toggle = () => {
    if (on) { setMethod("off"); setSetupOpen(false); return; }
    if (paired) { setMethod("bluetooth"); return; }
    setSetupOpen(true);
    startScan();
  };

  const choose = (d: { id: string; name: string }) => {
    setPairedDevice(d);
    setPaired(d);
    setFound([]);
    setSetupOpen(false);
    // Pairing IS choosing this as the HR source (it replaces a health-store
    // method — hrMethod is single-select by design: one HR source per run).
    setMethod("bluetooth");
    showToast?.(t("settings.hrSensor.paired", { name: d.name }));
  };
  const forget = () => {
    forgetPairedDevice();
    setPaired(null);
    setFound([]);
    if (settings.hrMethod === "bluetooth") setMethod("off");
  };

  return (
    <div className="space-y-2">
      <RowShell
        icon={<Bluetooth size={16} />}
        label={t("settings.connections.ble.label")}
        status={paired ? paired.name : t("settings.connections.notSetUp")}
        control={<ToggleSwitch on={on} onToggle={toggle} label={t("settings.connections.ble.label")} />}
      />
      {paired && (
        <div className="flex items-center justify-between gap-2 bg-slate-700/60 rounded-xl px-3 py-2">
          <span className="flex items-center gap-2 text-sm text-slate-200 min-w-0">
            <Bluetooth size={14} className="text-sky-400 shrink-0" />
            <span className="truncate">{paired.name}</span>
          </span>
          <span className="flex items-center gap-3 shrink-0">
            <button type="button" onClick={() => { setSetupOpen(true); startScan(); }}
              className="text-xs text-slate-400 hover:text-slate-200">{t("settings.hrSensor.pairAnother")}</button>
            <button type="button" onClick={forget} aria-label={t("settings.hrSensor.forgetAria")}
              className="text-slate-400 hover:text-red-400"><Trash2 size={15} /></button>
          </span>
        </div>
      )}
      {setupOpen && (
        <div className="space-y-2">
          <button type="button" onClick={startScan} disabled={scanning}
            className="w-full py-2.5 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center justify-center gap-2 disabled:opacity-50">
            {scanning ? <Loader size={15} className="animate-spin" /> : <Bluetooth size={15} />}
            {scanning ? t("settings.hrSensor.scanning") : t("settings.hrSensor.pair")}
          </button>
          {found.map(d => (
            <button key={d.id} type="button" onClick={() => choose(d)}
              className="w-full flex items-center justify-between gap-2 bg-slate-700/60 hover:bg-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200">
              <span className="truncate">{d.name}</span>
              {paired?.id === d.id && <Check size={15} className="text-emerald-400 shrink-0" />}
            </button>
          ))}
          {!scanning && !found.length && (
            <p className="text-xs text-slate-500">{t("settings.hrSensor.pairHelp")}</p>
          )}
        </div>
      )}
      {showDisclosure && (
        <HrSensorDisclosure onAccept={acceptDisclosure} onCancel={() => setShowDisclosure(false)} />
      )}
    </div>
  );
}

// ── Phone health store (Health Connect / Apple Health) ──────────────────────
// One row, one OS grant, two per-feature toggles. Which store renders is
// decided by the platform — the other platform's store never shows (a synced
// hrMethod naming it degrades to "off" here, per the synced-preference /
// local-readiness doctrine).
function HealthStoreRow({ settings, saveSettings, showToast, scanImportsNow }: ConnectionsProps) {
  const { t } = useTranslation();
  const storeMethod: HrMethod = isAndroid ? "healthconnect" : "healthkit";
  const storeLabel = t(isAndroid ? "settings.connections.store.labelHc" : "settings.connections.store.labelHk");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  // Per-feature grant state (null = still checking). Health Connect can grant
  // partially; HealthKit's single sheet covers both (and never reveals reads —
  // the markers are the completed-flow signal, see src/hr/healthkit.ts).
  const [hrGranted, setHrGranted] = useState<boolean | null>(null);
  const [watchGranted, setWatchGranted] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const src = isAndroid ? healthConnectSource : healthKitSource;
    src.checkPermissions().then(ok => { if (!cancelled) setHrGranted(ok); }).catch(() => {});
    const provider = importProviders.find(p => healthStoreProviderIds.has(p.id) && p.id === (isAndroid ? "healthconnect" : "healthkit"));
    Promise.resolve(provider?.isConnected ? provider.isConnected() : false)
      .then(ok => { if (!cancelled) setWatchGranted(!!ok); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const connected = !!hrGranted || !!watchGranted;
  const hrOn = settings.hrMethod === storeMethod;
  const watchOn = !!settings.watchImport;

  // One consent screen for everything the app reads from the store (heart rate
  // + exercise/distance/elevation) — the user never has to grant twice. On a
  // fresh grant, switch the features on for them (that's what "connect my
  // watch" means) — EXCEPT the HR method when another source is already
  // configured (a paired Bluetooth strap here, or a method synced from another
  // device): replacing an explicit choice needs an explicit tap on the toggle.
  const doConnect = async (): Promise<{ hr: boolean; watch: boolean }> => {
    setBusy(true);
    try {
      if (isAndroid) {
        const grant = await connectHealthConnect();
        if (grant.availability === "NotSupported") {
          showToast?.(t("settings.hrSensor.hcNotSupported"), "err");
          return { hr: false, watch: false };
        }
        setHrGranted(grant.heartRate);
        setWatchGranted(grant.activity);
        if (!grant.heartRate && !grant.activity) {
          showToast?.(
            grant.availability === "NotInstalled" ? t("settings.hrSensor.hcInstall") : t("settings.integrations.accessDenied"),
            "err");
        }
        return { hr: grant.heartRate, watch: grant.activity };
      }
      if (!(await healthKitSource.isAvailable())) {
        showToast?.(t("settings.hrSensor.hkNotSupported"), "err");
        return { hr: false, watch: false };
      }
      const ok = await healthKitSource.requestPermissions();
      setHrGranted(ok);
      setWatchGranted(ok);
      if (!ok) showToast?.(t("settings.hrSensor.hkDenied"), "err");
      return { hr: ok, watch: ok };
    } catch {
      showToast?.(t(isAndroid ? "settings.hrSensor.hcOpenFailed" : "settings.hrSensor.hkOpenFailed"), "err");
      return { hr: false, watch: false };
    } finally {
      setBusy(false);
    }
  };

  const scanNow = () => {
    scanImportsNow?.().then(n => { if (!n) showToast?.(t("settings.integrations.noNewRuns")); }).catch(() => {});
  };

  // Enable a feature only when THIS grant newly authorized it (was ungranted
  // before, granted now) — so a reconnect that broadens scope turns the new
  // feature on, but re-authorizing an already-granted store never flips a
  // toggle the user deliberately switched off. HR additionally only auto-enables
  // when no HR source is configured (never silently replaces a BLE strap or a
  // method synced from another device). `prev` is the granted state before the
  // grant call.
  const applyGrant = (prev: { hr: boolean; watch: boolean }, grant: { hr: boolean; watch: boolean }): boolean => {
    let next = settings;
    if (grant.watch && !prev.watch) next = withProviderEnabled(next, isAndroid ? "healthconnect" : "healthkit", true);
    if (grant.hr && !prev.hr && (settings.hrMethod || "off") === "off") next = { ...next, hrMethod: storeMethod };
    if (next !== settings) { saveSettings(next); return true; }
    return false;
  };

  const connectFirstTime = async () => {
    const grant = await doConnect();
    if (!grant.hr && !grant.watch) return;
    applyGrant({ hr: false, watch: false }, grant);
    showToast?.(t("settings.integrations.connectSuccess"));
    if (grant.watch) scanNow();
  };

  // Reconnect an already-connected store: re-run the grant and auto-enable any
  // feature it newly authorizes (the fix for a broader grant silently leaving
  // watch-import off), then scan if watch import just came on.
  const reconnect = async () => {
    const prev = { hr: !!hrGranted, watch: !!watchGranted };
    const grant = await doConnect();
    if (applyGrant(prev, grant) && grant.watch && !prev.watch) scanNow();
  };

  const toggleHr = async () => {
    if (hrOn) { saveSettings({ ...settings, hrMethod: "off" }); return; }
    if (!hrGranted) {
      const grant = await doConnect();
      if (!grant.hr) return;
    }
    saveSettings({ ...settings, hrMethod: storeMethod });
  };

  const toggleWatch = async () => {
    if (watchOn) { saveSettings({ ...settings, watchImport: false }); return; }
    if (!watchGranted) {
      const grant = await doConnect();
      if (!grant.watch) return;
    }
    saveSettings({ ...settings, watchImport: true });
    scanNow();
  };

  const scanOlder = async () => {
    if (!scanImportsNow) return;
    setScanning(true);
    try {
      const n = await scanImportsNow();
      if (!n) showToast?.(t("settings.integrations.noRuns30"));
    } catch {
      showToast?.(t("settings.integrations.scanFailed"), "err");
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="space-y-2 pt-3 border-t border-slate-700/60">
      <RowShell
        icon={<Watch size={16} />}
        label={storeLabel}
        status={connected ? t("settings.connections.connected") : t("settings.connections.notSetUp")}
        control={connected ? (
          <button type="button" onClick={() => { void reconnect(); }} disabled={busy}
            aria-label={t("settings.connections.reconnect")}
            className="text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50 shrink-0">
            {busy ? <Loader size={14} className="animate-spin" /> : t("settings.connections.reconnect")}
          </button>
        ) : (
          <button type="button" onClick={connectFirstTime} disabled={busy}
            className="px-3 py-2 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center justify-center gap-2 disabled:opacity-50 shrink-0">
            {busy && <Loader size={14} className="animate-spin" />}
            {t("settings.connections.connectBtn")}
          </button>
        )}
      />
      {connected && (
        <div className="space-y-3 bg-slate-700/40 rounded-xl px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-slate-200">{t("settings.connections.store.hrToggle")}</p>
              <p className="text-xs text-slate-500">{t("settings.connections.store.hrToggleDesc")}</p>
            </div>
            <ToggleSwitch on={hrOn} onToggle={() => { void toggleHr(); }} label={t("settings.connections.store.hrToggle")} disabled={busy} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-slate-200">{t("settings.connections.store.watchToggle")}</p>
              <p className="text-xs text-slate-500">{t("settings.connections.store.watchToggleDesc")}</p>
            </div>
            <ToggleSwitch on={watchOn} onToggle={() => { void toggleWatch(); }} label={t("settings.connections.store.watchToggle")} disabled={busy} />
          </div>
          {watchOn && (
            <button type="button" onClick={scanOlder} disabled={scanning}
              className="w-full py-2 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center justify-center gap-2 disabled:opacity-50">
              {scanning ? <Loader size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              {t("settings.integrations.scan30")}
            </button>
          )}
        </div>
      )}
      {/* Which watches this store actually covers — row help, same shape as the
          cloud rows below. It used to live in the card-level footnote, where it
          read as an answer to whatever row happened to sit above it. */}
      <div className="pl-[26px]">
        <HowItWorks label={t("settings.connections.howItWorksNamed", { name: storeLabel })}>
          <p>{t(isAndroid ? "settings.integrations.providers.healthconnect.help" : "settings.integrations.providers.healthkit.help")}</p>
        </HowItWorks>
      </div>
    </div>
  );
}

// ── Cloud providers (Polar and Suunto today; COROS on the same seam) ─────────
function CloudRow({ provider, settings, saveSettings, showToast, scanImportsNow }: ConnectionsProps & { provider: ImportProvider }) {
  const { t } = useTranslation();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  // Live progress of this provider's sync (the first-connect backfill can run
  // for a while) — null when idle. Fed by the id-scoped rc-cloud-sync-progress
  // events the provider's scan dispatches.
  const [syncCount, setSyncCount] = useState<number | null>(null);

  useEffect(() => {
    const onProgress = (e: Event) => {
      const d = (e as CustomEvent<{ id?: string; fetched?: number; done?: boolean }>).detail;
      if (d?.id !== provider.id) return;
      setSyncCount(d.done ? null : (d.fetched ?? 0));
    };
    window.addEventListener("rc-cloud-sync-progress", onProgress);
    return () => window.removeEventListener("rc-cloud-sync-progress", onProgress);
  }, [provider]);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(provider.isConnected ? provider.isConnected() : false)
      .then(ok => { if (!cancelled) setConnected(!!ok); })
      .catch(() => { if (!cancelled) setConnected(false); });
    // A native OAuth return completes out-of-band (deep link → RunningCoach
    // exchange) — refresh this row's state when it lands so the user sees
    // "connected" without reopening Settings. The event carries the provider id
    // in its detail so this only fires the matching row (Polar, Suunto and
    // COROS share this seam — a bare event would flip every cloud row).
    const onDone = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (!cancelled && id === provider.id) setConnected(true);
    };
    window.addEventListener("rc-cloud-connected", onDone);
    return () => { cancelled = true; window.removeEventListener("rc-cloud-connected", onDone); };
  }, [provider]);

  const on = providerEnabledInSettings(settings, provider.id) && !!connected;
  const label = t(`settings.integrations.providers.${provider.id}.label`, { defaultValue: provider.label });
  const help = t(`settings.integrations.providers.${provider.id}.help`, { defaultValue: provider.help || "" });

  const connect = async () => {
    setBusy(true);
    try {
      // connect() resolving false means "authorization was refused, in place".
      // "pending" means the flow left for the system browser (native OAuth) and
      // the outcome arrives later via the rc-cloud-connected event — no toast,
      // no state change now. A WEB redirect provider instead returns a
      // never-settling promise (the page navigates away before it could
      // resolve), so this spinner simply rides into the redirect.
      const res = provider.connect ? await provider.connect() : false;
      if (res === "pending") return;
      setConnected(res);
      if (res) {
        saveSettings(withProviderEnabled(settings, provider.id, true));
        showToast?.(t("settings.integrations.connectSuccess"));
        // Instant payoff: scan straight away for anything already waiting.
        scanImportsNow?.().then(n => { if (!n) showToast?.(t("settings.integrations.noNewRuns")); }).catch(() => {});
      } else {
        showToast?.(t("settings.integrations.accessDenied"), "err");
      }
    } catch {
      showToast?.(t("settings.integrations.connectFailed"), "err");
    } finally {
      setBusy(false);
    }
  };

  const turnOff = () => {
    saveSettings(withProviderEnabled(settings, provider.id, false));
    setConnected(false);
    provider.disconnect?.();
  };

  // A cloud provider is cursor-based, not windowed: the server decides what's
  // new from its own watermark and the `days` option is ignored entirely. So
  // this row must not promise "last 30 days" — during a first-connect backfill
  // it's reaching years back, and a workout older than the window imports fine.
  const syncNow = async () => {
    if (!scanImportsNow) return;
    setScanning(true);
    try {
      const n = await scanImportsNow();
      if (!n) showToast?.(t("settings.integrations.noNewRuns"));
    } catch {
      showToast?.(t("settings.integrations.scanFailed"), "err");
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="space-y-2 pt-3 border-t border-slate-700/60">
      <RowShell
        icon={<Watch size={16} />}
        label={label}
        status={syncCount != null
          ? t("settings.integrations.syncProgress", { count: syncCount })
          : on ? t("settings.connections.connected") : t("settings.connections.notSetUp")}
        control={on ? (
          <button type="button" onClick={turnOff}
            className="text-xs text-slate-400 hover:text-slate-200 shrink-0">{t("settings.integrations.turnOff")}</button>
        ) : (
          <button type="button" onClick={connect} disabled={busy}
            className="px-3 py-2 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center justify-center gap-2 disabled:opacity-50 shrink-0">
            {busy && <Loader size={14} className="animate-spin" />}
            {t("settings.connections.connectBtn")}
          </button>
        )}
      />
      {on && (
        <button type="button" onClick={syncNow} disabled={scanning}
          className="w-full py-2 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center justify-center gap-2 disabled:opacity-50">
          {scanning ? <Loader size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          {t("settings.integrations.syncNow")}
        </button>
      )}
      {/* Named after the provider, and indented under its row: the card closes
          with its own collapsible, and two disclosures a few pixels apart both
          reading "How it works" is unreadable — you can't tell which one
          answers "what does connecting Polar do?". Indent + name = the row's
          help, not the card's. */}
      {help && !on && (
        <div className="pl-[26px]">
          <HowItWorks label={t("settings.connections.howItWorksNamed", { name: label })}><p>{help}</p></HowItWorks>
        </div>
      )}
    </div>
  );
}

// ── Web pointer to the mobile apps ───────────────────────────────────────────
// The sensor + health-store rows are native-only; on web they collapse into
// this single pointer instead of rendering as disabled controls. Plain <a>
// links — this is the web build, no Capacitor browser concerns.
function MobileAppPointer() {
  const { t } = useTranslation();
  const iosUrl = APP_STORE_URL || TESTFLIGHT_BETA_URL;
  return (
    <div className="space-y-2 pt-3 border-t border-slate-700/60">
      <RowShell
        icon={<Smartphone size={16} />}
        label={t("settings.connections.mobile.title")}
      />
      {/* Full paragraph, NOT RowShell's one-line truncating status slot: this
          copy names the supported watches (Garmin/Zepp via Health Connect,
          Apple Watch via Apple Health) — it's the install pitch, don't cut it. */}
      <p className="text-xs text-slate-500">{t("settings.connections.mobile.desc")}</p>
      <div className="grid grid-cols-2 gap-2">
        <a href={PLAY_STORE_BETA_URL} target="_blank" rel="noopener noreferrer"
          className="py-2.5 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 text-center">
          {t("settings.connections.mobile.android")}
        </a>
        <a href={iosUrl} target="_blank" rel="noopener noreferrer"
          className="py-2.5 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 text-center">
          {t("settings.connections.mobile.ios")}
        </a>
      </div>
    </div>
  );
}

export function ConnectionsCard(props: ConnectionsProps) {
  const { t } = useTranslation();
  const { showToast } = props;
  const [cloudProviders, setCloudProviders] = useState<ImportProvider[]>([]);
  // Hidden developer sync-log: tap the section title 5× to toggle it (moved
  // here from the old Integrations section — same key, same behaviour).
  const [debug, setDebug] = useState(isWatchDebugEnabled());
  const tapsRef = useRef(0);
  // Both flags move together, here and nowhere else. The panels used to clear
  // one each on their own Hide button, which left the card seeded from the watch
  // flag while `fileShellReport`'s gate (the geo flag) was off — an open panel
  // whose Send button could only ever fail.
  const armDeveloperLogs = (on: boolean) => {
    setWatchDebug(on);
    setGeoDebug(on); // arms GPS tracking logging too (off = no cost on normal runs)
    setDebug(on);
  };
  const revealTap = () => {
    tapsRef.current += 1;
    if (tapsRef.current < 5) return;
    tapsRef.current = 0;
    const next = !isWatchDebugEnabled();
    armDeveloperLogs(next);
    // File immediately on enabling: the native shell log is always recording, so
    // at the moment someone turns this on there is usually already a report worth
    // having, and nothing else files one — the Send button below is the only
    // other path, and it needs someone to press it. Turning the log on after
    // something went wrong and having nothing arrive is the trap this closes.
    if (next) void fileShellReport("manual: developer logs enabled").catch(() => {});
    showToast?.(next ? "Developer logs enabled" : "Developer logs hidden");
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: ImportProvider[] = [];
      for (const p of importProviders) {
        if (p.kind === "cloud" && p.connect && (await p.isAvailable())) out.push(p);
      }
      if (!cancelled) setCloudProviders(out);
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="bg-slate-800 rounded-2xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <p onClick={revealTap} className="text-sm font-semibold text-slate-200 select-none">{t("settings.connections.title")}</p>
        <BetaBadge label={t("settings.newBeta")} />
      </div>
      <p className="text-xs text-slate-400 -mt-1">{t("settings.connections.subtitle")}</p>

      {isNative && <BleRow {...props} />}
      {isNative && <HealthStoreRow {...props} />}
      {cloudProviders.map(p => <CloudRow key={p.id} provider={p} {...props} />)}
      {!isNative && <MobileAppPointer />}

      {/* Card-level footnote: caveats that apply to EVERY row above, so it is
          labelled for the card, not "How it works" (which a reader lands on
          right after a row's own help and reasonably takes for more of it). */}
      <HowItWorks label={t("settings.connections.aboutLabel")}>
        <p>{t("settings.connections.betaNote")}</p>
        {isNative && <p>{t("settings.connections.help.oneHrSource")}</p>}
        <p>{t("settings.connections.help.hrEditable")}</p>
      </HowItWorks>

      {debug && <WatchSyncLog onHide={() => armDeveloperLogs(false)} />}
      {debug && isNative && <TrackDiagLog onHide={() => armDeveloperLogs(false)} />}
    </div>
  );
}
