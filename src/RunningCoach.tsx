import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { isNative } from "./native";
import { App as CapApp } from "@capacitor/app";
import type { PluginListenerHandle } from "@capacitor/core";
import { dismissTop } from "./utils/backDismiss";
import { isLangId, setLocale } from "./i18n";
import { Loader, MessageCircle, Settings } from "lucide-react";
import { BrandLogo } from "./components/BrandLogo";
import { db, currentUserId } from "./db";
import { STORAGE_KEYS, USER_CONTEXT_MAX_CHARS, USER_CONTEXT_NOTICE_CHARS } from "./constants";
import { track } from "./telemetry";
import { buildPlan, carryProgress, findOpenPlanSession } from "./utils/plan";
import { ymd, fmt } from "./utils/format";
import { computeBadges, unlockedIds } from "./utils/badges";
import { detectAnyRace, findEdition, editionLabel, loadCatalogue } from "./utils/races";
import { addRace, addEdition } from "./races";
import { deleteRoute, removePendingRoute, getAllRoutes, restoreRoutes, flushPendingRoutes } from "./routes";
import { flushPendingHr, hasHealthConnectAuthorization } from "./hr/healthconnect";
import { flushPendingHkHr } from "./hr/healthkit";
import { markSeen, WATCH_MANUAL_SCAN_DAYS, WATCH_AUTO_SCAN_COOLDOWN_MS } from "./watch/import";
import { scanAllProviders, providerEnabledInSettings } from "./imports/registry";
import { completePolarAuth } from "./imports/providers/polar";
import { persistImportedRoutes } from "./imports/persistRoutes";
import { Toast } from "./components/Toast";
import { Confetti } from "./components/Confetti";
import { ChunkLoadBoundary } from "./components/ChunkLoadBoundary";
import { usePresence } from "./hooks/usePresence";
import { OnboardingWizard } from "./modals/OnboardingWizard";
import { BackupModal } from "./modals/BackupModal";
import { RestoreModal } from "./modals/RestoreModal";
import { SettingsModal } from "./modals/SettingsModal";
import { DeleteAccountModal } from "./modals/DeleteAccountModal";
import { RaceFormModal } from "./modals/RaceFormModal";
import { LiveRunTracker } from "./modals/LiveRunTracker";
import { RunDetailModal } from "./modals/RunDetailModal";
import { Dashboard } from "./views/Dashboard";
import { PlanView } from "./views/PlanView";
import { LogView } from "./views/LogView";
import { RacesView } from "./views/RacesView";
import { ProgressView } from "./views/ProgressView";
import { BottomNav } from "./components/BottomNav";
import type {
  CatalogueRace,
  CoachSessionContext,
  CoachSource,
  JoinedEdition,
  Plan,
  PlanPrefill,
  RacesState,
  RouteBackup,
  Run,
  RunHighlight,
  RunPatch,
  SettingsState,
  ToastAction,
  ToastState,
  UserContextState,
} from "./types";

type ProgressSub = "log" | "stats" | "badges";
type PromotableEdition = { name: string; raceId?: string; edition: { id: string; date: string; distanceKm: number; elevation?: number } };

// Lazy: pulls in react-markdown + remark-gfm (~47 KB gzipped) for rendering
// the coach's markdown replies. On the web that weight only belongs on the
// wire once someone actually opens the chat; on native the bundle already
// ships inside the app package, so the boot-time prefetch below (isNative
// branch) warms it immediately instead — a nearly-instant open with no
// web-only cost.
const CoachChat = lazy(() => import("./modals/CoachChat").then(m => ({ default: m.CoachChat })));

// In-app "review notification" helper (pure, module-level so it isn't a hook
// dependency): when a maintainer verifies one of the user's OWN catalogue
// contributions, we thank them once. `ackVerified` (in the personal blob, so it
// rides backup) records which verified ids we've already acknowledged. Returns
// the (possibly updated) races object plus the freshly-verified ids — the caller
// toasts. Seeds silently on the first reconcile so a pre-existing set never floods.
function computeVerifiedThanks(cat: CatalogueRace[], racesObj: RacesState, uid: string | null | undefined) {
  if (!uid) return { next: racesObj, fresh: [] };
  const mine = [];
  for (const r of cat) {
    if (r.createdBy === uid && r.verified) mine.push("race:" + r.slug);
    for (const e of r.editions || []) if (e.createdBy === uid && e.verified) mine.push("ed:" + e.id);
  }
  const ackVerified = racesObj.ackVerified;
  if (ackVerified == null) return { next: { ...racesObj, ackVerified: mine }, fresh: [] };
  const fresh = mine.filter(id => !ackVerified.includes(id));
  if (!fresh.length) return { next: racesObj, fresh: [] };
  return { next: { ...racesObj, ackVerified: [...ackVerified, ...fresh] }, fresh };
}

const memoryKey = (line: unknown) => String(line || "").toLowerCase().replace(/^\d{4}-\d{2}-\d{2}:\s*/, "").replace(/[^a-z0-9]+/g, " ").trim();
const weekMs = 7 * 86400000;

export default function RunningCoach({ onSignOut = () => {} }: { onSignOut?: () => void }) {
  const { t } = useTranslation();
  const [loading,     setLoading]     = useState(true);
  const [tab,         setTab]         = useState("dash");
  const [runs,        setRuns]        = useState<Run[]>([]);
  const [plan,        setPlan]        = useState<Plan | null>(null);
  const [settings,    setSettings]    = useState<SettingsState>({
    raceDate:"", goalSec:"", distanceKm:"", raceElevation:0, name:"",
    age:0, maxHR:0, restHR:60, onboarded:false, onboardStep:0, intent:null,
    healthAck:null, hrMethod:"off", hrOptOut:false,
    planSessions:[{dayOffset:2,minutes:30},{dayOffset:6,minutes:60}],
  });
  const [toast,       setToast]       = useState<ToastState | null>(null);
  const toastIdRef = useRef(0);
  // Hold the toast ~200ms past dismissal so its exit animation can play (it
  // otherwise hard-unmounts the moment the auto-dismiss timer nulls it).
  const toastP = usePresence(toast, 200);
  const [celebrate,   setCelebrate]   = useState(false);
  const [logPrefill,  setLogPrefill]  = useState<(Partial<Run> & { wNum?: number; sId?: string }) | null>(null);
  const [prefillVer,  setPrefillVer]  = useState(0);
  const [showBackup,  setShowBackup]  = useState(false);
  const [showRestore, setShowRestore] = useState(false);
  const [showSettings,setShowSettings]= useState(false);
  const [showDeleteAccount,setShowDeleteAccount]= useState(false);
  const [onboarding,  setOnboarding]  = useState(false);
  const [showTracker, setShowTracker] = useState(false);
  // Plan session the tracker was opened from ("Record run" on a session card),
  // threaded into the save prefill so LogView's onSaved auto-ticks it.
  const [trackerLink, setTrackerLink] = useState<{ wNum: number; sId: string } | null>(null);
  // A distance to pre-open the route finder with (set when the tracker is opened
  // from a plan session's "Find a route"). Kept SEPARATE from trackerLink, which
  // flows into the saved run's prefill — this must not.
  const [trackerFindKm, setTrackerFindKm] = useState<number | undefined>(undefined);
  const [backupRoutes,setBackupRoutes]= useState<RouteBackup[]>([]);
  // Personal races layer (wishlist / completed + seen-badge set). seenBadges is
  // null until first-run seeding so we can tell "never computed" from "none".
  const [races,       setRaces]       = useState<RacesState>({ participations: [], seenBadges: null });
  const [userContext, setUserContext] = useState<UserContextState>({ notes: "" });
  // Always-fresh mirror of `races` so async callbacks (the boot catalogue load)
  // merge onto the latest state, not a stale snapshot captured before the user
  // could touch their races mid-load. Synced in an effect (the catalogue resolves
  // well after any concurrent change has committed).
  const racesRef = useRef(races);
  useEffect(() => { racesRef.current = races; }, [races]);
  // Native only: warm the lazy CoachChat chunk right after boot so opening the
  // coach feels instant — the JS is already local to the app package, so
  // fetching it early costs nothing. The web build deliberately skips this and
  // only fetches on first open, keeping the ~47 KB react-markdown dependency
  // off the initial page load.
  useEffect(() => { if (isNative) import("./modals/CoachChat"); }, []);
  // Freshest runs, for the foreground Health Connect HR retry below (an effect
  // with [] deps must read current runs from a ref, not a stale closure).
  const runsRef = useRef(runs);
  useEffect(() => { runsRef.current = runs; }, [runs]);
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  const planRef = useRef(plan);
  useEffect(() => { planRef.current = plan; }, [plan]);
  // Latest watch-import scanner, refreshed each render so the long-lived boot /
  // foreground listeners always call a closure with current runs, plan and
  // addRuns/goLog (not a stale mount-time one).
  const checkWatchRef = useRef<(opts?: { days?: number; manual?: boolean }) => Promise<number>>(async () => 0);
  // Auto-surface the "found a run" toast at most once per app session so a run the
  // user chooses to ignore doesn't nag on every foreground (it re-surfaces on the
  // next launch, and the manual Settings scan is always available).
  const watchAutoShownRef = useRef(false);
  // And rate-limit empty auto-scans: without this, every background/foreground
  // flip re-runs the whole Health Connect round-trip (availability + permission
  // + readRecords + per-session aggregates) until something is found. A watch
  // takes minutes to sync anyway, so a cooldown loses nothing.
  const watchLastScanRef = useRef(0);
  const userContextRef = useRef(userContext);
  useEffect(() => { userContextRef.current = userContext; }, [userContext]);
  // Shared race catalogue (fetched, NOT in the blob). [] until it loads / on a
  // failed fetch — the app renders regardless.
  const [catalogue,   setCatalogue]   = useState<CatalogueRace[]>([]);
  const [showRaceForm,setShowRaceForm]= useState(false);
  const [detailRun,   setDetailRun]   = useState<Run | null>(null);
  const [showCoach,   setShowCoach]   = useState(false);
  // Set when the coach is opened about a specific plan session (see openCoach) so
  // the chat greets/steers about it and rides its context; null on a plain open.
  const [coachSession, setCoachSession] = useState<CoachSessionContext | null>(null);
  // Stash from a "Set as target" promote → consumed by PlanView's setup form.
  const [planPrefill, setPlanPrefill] = useState<PlanPrefill | null>(null);
  // Which Progress sub-tab to open, and a nonce so navigating there again (even
  // to the same sub-tab) re-applies it.
  const [progressSub,  setProgressSub]  = useState<ProgressSub>("log");
  const [progressNonce,setProgressNonce]= useState(0);
  // Runs to scroll to + flag in History after an async change (HR relink, watch
  // import). Set by goToRuns from a toast action; auto-cleared on a timeout.
  const [highlight,    setHighlight]    = useState<RunHighlight | null>(null);

  // An optional `action` ({label, onClick}) turns the toast into an undoable one.
  const showToast = (msg: string, type = "ok", action?: ToastAction) =>
    setToast({id: toastIdRef.current++, msg, type, action});
  const withLimitNotice = (ctx: UserContextState) => {
    const notes = ctx?.notes || "";
    if (notes.length < USER_CONTEXT_NOTICE_CHARS) return ctx;
    const last = ctx.lastLimitNoticeAt ? Date.parse(ctx.lastLimitNoticeAt) : 0;
    if (last && Date.now() - last < weekMs) return ctx;
    showToast(t("app.toasts.memoryFull"));
    return { ...ctx, lastLimitNoticeAt: new Date().toISOString() };
  };

  // Navigate to History and flag the given runs (scroll to the first, ring +
  // pill on each). The single seam behind the async-HR and watch-import toasts.
  const goToRuns = (ids: string[], label: string) => {
    const list = (ids || []).filter((id): id is string => !!id);
    if (!list.length) return;
    setHighlight({ ids: list, label });
    setProgressSub("log"); setProgressNonce(n => n + 1); setTab("progress");
  };
  // One toast when async HR relink fills in one or more runs (boot + foreground),
  // with a link that jumps to and flags those runs so the change is visible —
  // the relink lands minutes after the run, often on a screen the user isn't on.
  const notifyHrAdded = (ids: string[]) => {
    if (!ids.length) return;
    showToast(t("app.toasts.hrAdded", { count: ids.length }), "ok",
      { label: t("app.toasts.viewRuns", { count: ids.length }),
        onClick: () => goToRuns(ids, t("progress.history.hrBadge")) });
  };

  // Shared by both Health Connect / HealthKit HR retry points (boot + foreground)
  // below, so the relink logic can't drift between the two call sites. Applies
  // the fetched HR (or, for a run resolved some other way, just clears the
  // marker). The caller batches a single notifyHrAdded toast once its flush
  // settles, so this stays a pure state update.
  const patchRunHr = (runId: string, patch: RunPatch) => {
    setRuns(prev => {
      // A run carries at most ONE pending marker (hrPending on Android,
      // hrPendingHk on iOS), so one patch clears both fields harmlessly and
      // serves both platforms' flushers.
      const next = prev.map(x => x.id === runId ? { ...x, ...patch, hrPending: undefined, hrPendingHk: undefined } : x);
      db.set(STORAGE_KEYS.RUNS, next);
      return next;
    });
  };

  useEffect(() => {
    (async () => {
      const r = await db.get(STORAGE_KEYS.RUNS) as Run[] | null;
      const p = await db.get(STORAGE_KEYS.PLAN) as Plan | null;
      const s = await db.get(STORAGE_KEYS.SETTINGS) as Partial<SettingsState> | null;
      const rc = await db.get(STORAGE_KEYS.RACES) as Partial<RacesState> | null;
      const uc = await db.get(STORAGE_KEYS.USER_CONTEXT) as Partial<UserContextState> | null;
      if (r) setRuns(r);
      if (p) setPlan(p);
      if (s) setSettings(prev => ({...prev, ...s}));
      // The synced language preference wins over the boot-time device guess
      // once the blob arrives (async side-effect, not a sync setState).
      if (s && isLangId(s.language)) void setLocale(s.language);
      if (uc) {
        const nextContext = { notes: "", ...uc };
        userContextRef.current = nextContext;
        setUserContext(nextContext);
      }
      // Seed seenBadges silently the first time so existing users with history
      // don't get a flurry of unlock toasts on first launch of this feature.
      const loaded: RacesState = { participations: [], seenBadges: null, ...(rc || {}) };
      if (loaded.seenBadges == null) {
        loaded.seenBadges = unlockedIds(computeBadges(r || [], loaded.participations));
        db.set(STORAGE_KEYS.RACES, loaded);
      }
      setRaces(loaded);
      // First-time user, or onboarding started but not finished — resume it.
      // In-progress is marked by `onboardStep`; existing users who already have a
      // name (but no onboarding marker) are treated as onboarded.
      if (!s || (!s.onboarded && (s.onboardStep != null || !s.name))) setOnboarding(true);
      setLoading(false);
      // Load the shared catalogue WITHOUT blocking the splash: a slow/down
      // Supabase must not delay the app. On resolve, publish it and thank the
      // user for any of their contributions that a maintainer has since verified.
      loadCatalogue().then(cat => {
        setCatalogue(cat);
        // Merge onto the freshest races (racesRef), NOT the boot snapshot: the
        // user may have wishlisted/logged during the load, and that change must
        // not be clobbered by re-persisting a stale object.
        const cur = racesRef.current;
        const { next, fresh } = computeVerifiedThanks(cat, cur, currentUserId());
        if (next !== cur) { setRaces(next); db.set(STORAGE_KEYS.RACES, next); }
        if (fresh.length) {
          showToast(fresh.length === 1
            ? t("app.toasts.contributionVerified", { count: 1 })
            : t("app.toasts.contributionVerified", { count: fresh.length }));
        }
      });
      // Retry any GPS traces that couldn't be uploaded on a previous (offline)
      // save, and relink each to its run once it lands.
      flushPendingRoutes((tmpId, routeId) => {
        setRuns(prev => {
          const next = prev.map(r => r.routeTmp === tmpId
            ? { ...r, routeId, routePending: false, routeTmp: undefined } : r);
          db.set(STORAGE_KEYS.RUNS, next);
          return next;
        });
      });
      // Same deferred cleanup for Health Connect HR: a run saved before the watch
      // had synced its HR is stamped hrPending.
      // On boot, only open Health Connect if this *device* has previously granted
      // access. `settings.hrMethod` syncs across phones, so it is not enough to
      // prove the native bridge can be safely touched on this install.
      // Patch the loaded array directly instead of going through patchRunHr's
      // setRuns(prev => ...): React may not have committed setRuns(r) yet.
      // Actual relinks still run on foreground and when a run is saved.
      let bootRuns: Run[] = r || [];
      const bootHrFilled: string[] = [];
      const patchBootRunHr = (runId: string, patch: RunPatch) => {
        bootRuns = bootRuns.map(x => x.id === runId ? { ...x, ...patch, hrPending: undefined, hrPendingHk: undefined } : x);
        setRuns(bootRuns);
        db.set(STORAGE_KEYS.RUNS, bootRuns);
        if (patch.hr != null) bootHrFilled.push(runId);
      };
      // The iOS sibling runs alongside — each flusher only resolves (and only
      // clears) its own source's markers, so both are safe on either platform.
      // Notify once, after both settle, with a link to the filled-in runs.
      Promise.all([
        flushPendingHr(bootRuns, patchBootRunHr, {
          enabled: s?.hrMethod === "healthconnect",
          allowNativeRead: hasHealthConnectAuthorization(),
        }).catch(() => {}),
        flushPendingHkHr(bootRuns, patchBootRunHr, {
          enabled: s?.hrMethod === "healthkit",
        }).catch(() => {}),
      ]).then(() => notifyHrAdded(bootHrFilled));
    })();
    // Boot-once load: `t` is stable and must not re-trigger the whole boot on a
    // language switch, so it is intentionally omitted from the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-dismiss the toast. setState here runs from a timer callback (not
  // synchronously in the effect body), and clears on unmount / re-show. An
  // actionable (undo) toast lingers longer so it can actually be tapped.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.action ? 6000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Fade the run highlight (ring + "New"/"❤" pills) after a while so it doesn't
  // linger as a stale marker. Timer callback, not a sync setState in the effect.
  useEffect(() => {
    if (!highlight) return;
    const to = setTimeout(() => setHighlight(null), 12000);
    return () => clearTimeout(to);
  }, [highlight]);

  // Global back/Escape handling: the Android hardware back button and the web
  // Escape key close the topmost open overlay (via the useDismissable stack);
  // with nothing open they return to the home tab, and on Android a back press
  // already home lets the app exit. Registered once — the live tab is read
  // through a ref so this needn't re-subscribe the native listener on every tab
  // change. Onboarding deliberately does NOT register a dismiss, so it stays an
  // unskippable gate.
  const tabRef = useRef(tab);
  useEffect(() => { tabRef.current = tab; }, [tab]);
  useEffect(() => {
    const goBack = (): boolean => {
      if (dismissTop()) return true;
      if (tabRef.current !== "dash") { setTab("dash"); return true; }
      return false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && goBack()) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    let active = true;
    let handle: PluginListenerHandle | undefined;
    if (isNative) {
      CapApp.addListener("backButton", () => { if (!goBack()) CapApp.exitApp(); })
        .then(h => { if (active) handle = h; else h.remove?.(); });
    }
    return () => {
      active = false;
      window.removeEventListener("keydown", onKey);
      handle?.remove?.();
    };
  }, []);

  // Health Connect HR often lands minutes after a run finishes (once the watch
  // syncs), so retry the deferred relink whenever the app returns to the
  // foreground — not only on cold start.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      const filled: string[] = [];
      const collect = (runId: string, patch: RunPatch) => {
        patchRunHr(runId, patch);
        if (patch.hr != null) filled.push(runId);
      };
      Promise.all([
        flushPendingHr(runsRef.current, collect, {
          enabled: settingsRef.current.hrMethod === "healthconnect",
          allowNativeRead: hasHealthConnectAuthorization(),
        }).catch(() => {}),
        flushPendingHkHr(runsRef.current, collect, {
          enabled: settingsRef.current.hrMethod === "healthkit",
        }).catch(() => {}),
      ]).then(() => notifyHrAdded(filled));
      // A watch run often lands in Health Connect minutes after the run (once the
      // watch syncs to Garmin Connect), so re-scan on foreground too.
      checkWatchRef.current().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
    // patchRunHr only closes over stable setters — see the boot effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First watch-import scan once the initial data load has finished (runs are
  // needed for dedupe). Runs after the loading→false render so checkWatchRef holds
  // the committed scanner. Native + opt-in + local grant are all checked inside.
  useEffect(() => {
    if (loading) return;
    checkWatchRef.current().catch(() => {});
  }, [loading]);

  const savePlan     = (p: Plan) => { setPlan(p); db.set(STORAGE_KEYS.PLAN, p); track("plan_generated", {}); };
  const saveSettings = (s: SettingsState) => { setSettings(s); db.set(STORAGE_KEYS.SETTINGS, s); };

  // Complete a Polar OAuth return (a no-op on every normal load and when Polar is
  // unconfigured — gated on the state marker inside). On success, flip the
  // provider's enable flag on and scan straight away for anything already synced;
  // on a failed exchange, tell the user (they authorized and expect a result).
  // Two triggers share this: the boot effect (web returns — the page reloaded
  // through the redirect — and native cold-start relaunches), and the
  // "rc-polar-return" event App.tsx fires when the deep link lands warm.
  const finishPolarReturn = () => {
    completePolarAuth().then(result => {
      if (result === "idle") return;
      if (result === "failed") { showToast(t("settings.integrations.connectFailed"), "err"); return; }
      const next = { ...settingsRef.current, imports: { ...settingsRef.current.imports, polar: true } };
      saveSettings(next);
      // Update the ref synchronously too: the [settings] sync effect only runs
      // after React commits (a macrotask), but the scan below runs this tick and
      // gates Polar on providerEnabledInSettings(settingsRef.current) — without
      // this, the "scan straight away" would skip Polar until the next boot.
      settingsRef.current = next;
      showToast(t("settings.integrations.connectSuccess"));
      // Let an open settings panel flip its Polar row to "connected" without a
      // reopen (its per-provider isConnected checks only run on mount). The id
      // in detail scopes it to the Polar row (future Suunto/COROS rows ignore it).
      window.dispatchEvent(new CustomEvent("rc-cloud-connected", { detail: { id: "polar" } }));
      checkWatchRef.current({ manual: true }).catch(() => {});
    }).catch(() => {});
  };
  const finishPolarReturnRef = useRef(finishPolarReturn);
  // Latest-ref pattern (same as checkWatchRef above): the long-lived deep-link
  // listener below must call this render's closure, not a stale one.
  // eslint-disable-next-line react-hooks/refs
  finishPolarReturnRef.current = finishPolarReturn;
  useEffect(() => {
    if (loading) return;
    finishPolarReturnRef.current();
  }, [loading]);
  useEffect(() => {
    const onPolarReturn = () => finishPolarReturnRef.current();
    window.addEventListener("rc-polar-return", onPolarReturn);
    return () => window.removeEventListener("rc-polar-return", onPolarReturn);
  }, []);
  const saveUserContext = (next: Partial<UserContextState>) => {
    const clean = withLimitNotice({ notes: String(next?.notes || "").slice(0, USER_CONTEXT_MAX_CHARS), lastLimitNoticeAt: next?.lastLimitNoticeAt || null });
    userContextRef.current = clean;
    setUserContext(clean);
    db.set(STORAGE_KEYS.USER_CONTEXT, clean);
  };
  const appendUserContext = (lines: string | string[]) => {
    const incoming = (Array.isArray(lines) ? lines : [lines]).map(x => String(x || "").trim()).filter(Boolean);
    if (!incoming.length) return false;
    const prev = userContextRef.current || { notes: "" };
    const baseNotes = String(prev.notes || "");
    const existing = new Set(baseNotes.split("\n").map(memoryKey).filter(Boolean));
    const nextLines = [];
    let joined = baseNotes.trim();
    for (const line of incoming) {
      const key = memoryKey(line);
      if (!key || existing.has(key)) continue;
      const candidate = [joined, line].filter(Boolean).join("\n");
      if (candidate.length > USER_CONTEXT_MAX_CHARS) continue;
      existing.add(key);
      nextLines.push(line);
      joined = candidate;
    }
    if (!nextLines.length) return false;
    const next = withLimitNotice({ ...prev, notes: joined });
    userContextRef.current = next;
    setUserContext(next);
    db.set(STORAGE_KEYS.USER_CONTEXT, next);
    return true;
  };

  // Fold badge state into a races object: silently seed `seenBadges` the first
  // time (no toast flurry for existing users), then toast only genuinely new
  // unlocks. Pure-ish — only side effect is the toast — so it's safe to call
  // from event handlers (badges are derived, never an effect/cascading render).
  const reconcileBadges = (nextRuns: Run[], nextRaces: RacesState): RacesState => {
    const badges = computeBadges(nextRuns, nextRaces.participations || []);
    const unlocked = unlockedIds(badges);
    if (nextRaces.seenBadges == null) return { ...nextRaces, seenBadges: unlocked };
    const seenBadges = nextRaces.seenBadges;
    const fresh = unlocked.filter(id => !seenBadges.includes(id));
    if (!fresh.length) return nextRaces;
    const first = badges.find(b => b.id === fresh[0]);
    showToast(fresh.length === 1 ? t("app.toasts.badgeUnlocked", { count: 1, label: first?.label || t("app.toasts.newBadge") }) : t("app.toasts.badgeUnlocked", { count: fresh.length }), "badge");
    return { ...nextRaces, seenBadges: unlocked };
  };
  const commitRaces = (next: RacesState) => { setRaces(next); db.set(STORAGE_KEYS.RACES, next); };
  // Passed to children: persist a races change and reconcile badges off it.
  const saveRaces  = (next: RacesState) => commitRaces(reconcileBadges(runs, next));

  // Apply a coach-accepted plan. carryProgress re-stamps done/skipped/runId by
  // session id, so a session ticked while the chat was open isn't lost (the
  // coach tools never edit done sessions, so this can't undo an adjustment).
  // Deliberately NOT savePlan: that tracks "plan_generated" — this is an edit.
  const applyCoachPlan = (p: Plan) => {
    const merged = carryProgress(plan, p);
    setPlan(merged);
    db.set(STORAGE_KEYS.PLAN, merged);
  };

  // Toggle whether a wishlisted race is folded into the current plan. Persists the
  // flag and, if there's an active plan, rebuilds it preserving progress — so
  // adding a race shows up immediately without nuking completed sessions.
  const setRaceInPlan = (editionId: string, inPlan: boolean) => {
    const parts = (races.participations || []).map(p => p.editionId === editionId ? { ...p, inPlan } : p);
    saveRaces({ ...races, participations: parts });
    if (inPlan) track("plan_race_added", {});
    if (plan && settings.raceDate && settings.distanceKm) {
      const secRaces = parts
        .filter(p => p.status === "wishlist" && p.inPlan && p.editionId !== settings.targetEditionId)
        .map(p => ({ editionId: p.editionId, date: p.raceDate, distanceKm: p.distanceKm,
          elevation: p.editionId ? findEdition(p.editionId)?.edition?.elevation || 0 : 0 }));
      const np = buildPlan(settings.raceDate, settings.goalSec, settings.planSessions,
        settings.distanceKm, settings.raceElevation,
        { recentRuns: runs, races: secRaces, mainEditionId: settings.targetEditionId ?? null,
          style: settings.planStyle, level: settings.trainingLevel });
      savePlan(carryProgress(plan, np));
    }
  };

  // Re-fetch + re-hydrate the catalogue (after a user contributes), so the new
  // entry shows immediately — contributions are instant + global.
  const refreshCatalogue = async () => { setCatalogue(await loadCatalogue()); };

  // Promote a catalogue edition to the training target: stash the prefill and
  // send the user to PlanView's setup, which fills the date/distance/elevation
  // and a fresh realistic goal suggestion. Nothing is committed (no settings or
  // plan change) until the user picks a goal and builds — so we never leave an
  // unrealistic auto-goal behind. targetEditionId is set by PlanView on build.
  const promoteEdition = (joined: JoinedEdition | PromotableEdition) => {
    const e = joined.edition;
    setPlanPrefill({ raceDate: e.date, distanceKm: e.distanceKm, raceElevation: e.elevation || 0, editionId: e.id, label: editionLabel({ name: String(joined.name) }, e) });
    setTab("plan");
    track("race_target_set", {});
  };

  // Race-day auto-detect: when a just-saved run matches the date + distance of any
  // race on the plan (main or secondary), return the races object with that edition
  // marked done (plus the pre-change participations for Undo). `isMain` flags the
  // training target so the caller can prompt for the next race only then. null when
  // nothing matches.
  const detectCompletion = (added: Run[], baseRaces: RacesState) => {
    // Candidate races = every RACE session on the plan carrying an editionId,
    // deduped. This covers the main race (stamped from targetEditionId) and any
    // secondary races; a hand-entered target has no editionId and stays undetected.
    const cands: { editionId: string; date: string; distanceKm: number }[] = [];
    const seen = new Set<string>();
    (plan?.weeks || []).forEach(w => w.sessions.forEach(s => {
      if (s.type === "RACE" && s.editionId && !seen.has(s.editionId)) {
        seen.add(s.editionId);
        cands.push({ editionId: s.editionId, date: s.date, distanceKm: Number(s.km) });
      }
    }));
    // Fallback for plans built before RACE sessions carried editionId: detect the
    // main target off settings so existing users keep race-day auto-detect.
    if (settings.targetEditionId && settings.raceDate && settings.distanceKm && !seen.has(settings.targetEditionId)) {
      cands.push({ editionId: settings.targetEditionId, date: settings.raceDate, distanceKm: Number(settings.distanceKm) });
    }
    if (!cands.length) return null;
    let match = null, edId = null;
    for (const r of added) {
      const id = detectAnyRace(r, cands);
      if (id) { match = r; edId = id; break; }
    }
    if (!match) return null;
    const parts = baseRaces.participations || [];
    const prev = parts.find(p => p.editionId === edId) || null;
    if (prev?.status === "done") return null; // already logged — don't double-mark
    const joined = findEdition(edId);
    const ed = joined?.edition || { id: edId, date: match.date, distanceKm: match.km };
    const label = prev?.label || (joined ? editionLabel({ name: String(joined.name) }, ed) : t("app.toasts.yourRace"));
    const snapshot = { editionId: edId, raceId: joined?.raceId, label, raceDate: ed.date, distanceKm: ed.distanceKm };
    const done = { ...(prev || snapshot), status: "done", timeSec: match.durationSec, runId: match.id, source: "auto", notes: prev?.notes || "" };
    const next = prev ? parts.map(p => p.editionId === edId ? done : p) : [...parts, done];
    return { nextRaces: { ...baseRaces, participations: next }, undoParts: parts, label, isMain: edId === settings.targetEditionId };
  };

  // `opts.skipDetect` is set when the run is created by the Races "log result"
  // flow, which already marks the race done — so we don't double-detect it.
  const addRuns = (rs: Partial<Run>[], opts: { skipDetect?: boolean } = {}) => {
    const added: Run[] = rs.map((r, i) => ({...r, date: r.date || ymd(new Date()), km: Number(r.km) || 0, id: r.id || ("r" + Date.now() + i)} as Run));
    const nextRuns = added.concat(runs).sort((a, b) => b.date.localeCompare(a.date));
    setRuns(nextRuns); db.set(STORAGE_KEYS.RUNS, nextRuns);
    // Watch imports: remember which Health Connect sessions have landed so a
    // rescan never re-offers them (idempotent even if the run is later deleted).
    markSeen(added.map(r => r.hcId).filter((id): id is string => !!id));
    // Telemetry-safe: how a run reached the log (GPS vs manual) and how many at once
    // (CSV import lands as a batch). No run contents are sent.
    track("run_logged", { count: rs.length, source: rs[0]?.source || "manual" });
    // Race-day auto-detect, then reconcile badges against the new runs + races.
    const det = opts.skipDetect ? null : detectCompletion(added, races);
    const merged = reconcileBadges(nextRuns, det ? det.nextRaces : races);
    commitRaces(merged);
    if (det) {
      track("race_completed", { source: "auto" });
      if (det.isMain) setCelebrate(true);
      showToast(t("app.toasts.loggedAsRace", { label: det.label }), "ok",
        { label: t("common.undo"), onClick: () => commitRaces(reconcileBadges(nextRuns, { ...merged, participations: det.undoParts })) });
    }
    // Return the runs as stored (with generated ids) so a caller can flag them.
    return added;
  };

  const toggleSess = (wNum: number, sId: string) => {
    setPlan(prev => {
      if (!prev) return prev;
      const p = {...prev,
        weeks: prev.weeks.map(w => {
          if (w.weekNumber !== wNum) return w;
          return {...w,
            sessions: w.sessions.map(s => s.id !== sId ? s : {...s, done: !s.done, skipped: false}),
          };
        }),
      };
      db.set(STORAGE_KEYS.PLAN, p);
      return p;
    });
  };

  const skipSess = (wNum: number, sId: string) => {
    setPlan(prev => {
      if (!prev) return prev;
      const p = {...prev,
        weeks: prev.weeks.map(w => {
          if (w.weekNumber !== wNum) return w;
          return {...w,
            sessions: w.sessions.map(s => s.id !== sId ? s : {...s, skipped: !s.skipped, done: false}),
          };
        }),
      };
      db.set(STORAGE_KEYS.PLAN, p);
      return p;
    });
  };

  const deleteRun = (id: string) => {
    setRuns(prev => {
      const r = prev.find(x => x.id === id);
      // Drop the trace too (privacy) — whether already synced (routeId, or an
      // HR-only sidecar under hrRouteId) or still waiting in the offline queue
      // (routeTmp), so a deleted run never leaks its route/HR to the cloud on a
      // later flush.
      if (r?.routeId) deleteRoute(r.routeId);
      if (r?.hrRouteId) deleteRoute(r.hrRouteId);
      if (r?.routeTmp) removePendingRoute(r.routeTmp);
      const next = prev.filter(x => x.id !== id);
      db.set(STORAGE_KEYS.RUNS, next);
      return next;
    });
    showToast(t("app.toasts.runDeleted"));
  };

  const updateRun = (id: string, patch: RunPatch) => {
    setRuns(prev => {
      // The date may have changed, so re-sort to keep the list newest-first.
      const next = prev.map(r => r.id === id ? {...r, ...patch} : r)
        .sort((a, b) => b.date.localeCompare(a.date));
      db.set(STORAGE_KEYS.RUNS, next);
      return next;
    });
    showToast(t("app.toasts.runUpdated"));
  };

  const exportData    = async () => {
    // GPS traces live in their own table, so pull them in to make the backup
    // self-contained (and portable for data-export requests).
    let routes: RouteBackup[] = [];
    try { routes = await getAllRoutes(); } catch { /* backup still works without */ }
    setBackupRoutes(routes);
    setShowBackup(true);
  };
  const handleRestore = (d: { runs?: Run[]; plan?: Plan | null; settings?: Partial<SettingsState>; races?: RacesState; userContext?: UserContextState; routes?: RouteBackup[] }) => {
    if (d.runs)     { setRuns(d.runs);         db.set(STORAGE_KEYS.RUNS, d.runs); }
    if (d.plan)     { setPlan(d.plan);          db.set(STORAGE_KEYS.PLAN, d.plan); }
    if (d.settings) { const nextSettings = { ...settings, ...d.settings }; setSettings(nextSettings);  db.set(STORAGE_KEYS.SETTINGS, nextSettings);
      // Apply a restored language immediately (like the boot-load path), so the
      // UI switches to the backup's preference instead of staying on the old one.
      if (isLangId(nextSettings.language)) void setLocale(nextSettings.language); }
    if (d.races)    { setRaces(d.races);         db.set(STORAGE_KEYS.RACES, d.races); }
    if (d.userContext) saveUserContext(d.userContext);
    if (d.routes)   { restoreRoutes(d.routes as Parameters<typeof restoreRoutes>[0]); }
    showToast(t("app.toasts.restored", { n: d.runs ? d.runs.length : 0 }));
  };

  if (loading) return (
    <div className="h-screen bg-slate-900 flex items-center justify-center">
      <Loader className="text-orange-400 animate-spin" size={32}/>
    </div>
  );

  const goLog = (prefill?: Partial<Run> & { wNum?: number; sId?: string }) => { setLogPrefill(prefill || null); setTab("log"); if (prefill) setPrefillVer(v => v + 1); };

  // Scan every registered import integration (src/imports/registry.ts — today
  // effectively Health Connect) for finished runs and offer to import them. Auto
  // (boot/foreground) scans a 7-day window once per session; the Settings "scan
  // older runs" button passes manual + a wider window and always runs. A single
  // run goes through the LogView review (so it auto-ticks a matching plan session
  // and the user can fix its type); several land as a batch. Returns how many new
  // runs were found (for the Settings UI's feedback).
  const scanImports = async ({ days, manual = false }: { days?: number; manual?: boolean } = {}) => {
    if (!manual && (watchAutoShownRef.current || Date.now() - watchLastScanRef.current < WATCH_AUTO_SCAN_COOLDOWN_MS)) return 0;
    watchLastScanRef.current = Date.now();
    const scanned = await scanAllProviders(runsRef.current, {
      ...(days ? { days } : {}),
      trigger: manual ? "manual" : "auto", // diagnostics label for the sync-log
      // The synced preference gates the health-store providers (watchImport is
      // shared by Health Connect and HealthKit); providers only check
      // device-local state (grant markers) themselves.
      enabled: p => providerEnabledInSettings(settingsRef.current, p.id) || !p.connect,
    });
    // Persist any route trace / raw HR series a provider returned and swap them
    // for a routeId (GPS) or hrRouteId (HR-only) — the transient points/hrSamples
    // never belong in the stored run (blob bloat). HealthKit imports Apple Watch
    // routes + HR; Health Connect imports HR series (no routes exist there yet).
    const found = scanned.length ? await persistImportedRoutes(scanned) : [];
    if (!found.length) return 0;
    if (!manual) watchAutoShownRef.current = true;
    if (found.length === 1) {
      const r = found[0];
      showToast(t("app.toasts.foundRun", { km: r.km, date: fmt.sht(r.date || "") }), "ok",
        { label: t("app.toasts.review"), onClick: () => goLog({ ...r, ...(findOpenPlanSession(planRef.current, r.date || "") || {}) }) });
    } else {
      showToast(t("app.toasts.foundRuns", { n: found.length }), "ok",
        { label: t("app.toasts.importAll"), onClick: () => {
          const added = addRuns(found);
          // Jump to History and flag the freshly imported runs as "New".
          goToRuns(added.map(a => a.id).filter((id): id is string => !!id), t("progress.history.newBadge"));
        } });
    }
    return found.length;
  };
  // Latest-ref pattern: keep the ref pointing at this render's scanner so the
  // long-lived boot/foreground listeners always call one with fresh runs/plan.
  // eslint-disable-next-line react-hooks/refs
  checkWatchRef.current = scanImports;
  const goProgress = (sub?: string) => { setProgressSub(sub === "stats" || sub === "badges" ? sub : "log"); setProgressNonce(n => n + 1); setTab("progress"); };
  const openSettings = () => { saveUserContext(userContextRef.current); setShowSettings(true); };
  // A session-context object opens the coach about that session; a bare call
  // (or an event from onClick={openCoach}) opens a fresh chat. Guard on shape
  // so the click event never counts as a session. `source` is analytics only.
  const openCoach = (session?: unknown, source?: CoachSource) => {
    const ctx = session && typeof session === "object" && "session" in session ? session as CoachSessionContext : null;
    setCoachSession(ctx); setShowCoach(true);
    track("coach_opened", { source: source || (ctx ? "plan_session" : "other") });
  };
  const shared = {runs, plan, settings, races, catalogue, userContext, addRuns, savePlan, saveSettings, saveUserContext, saveRaces, setRaceInPlan, promoteEdition, toggleSess, skipSess, buildPlan, exportData, deleteRun, updateRun, showToast, goTab: setTab, goLog, goProgress, goToRuns, highlight, openSettings, openRaceForm: () => setShowRaceForm(true),
    // A {wNum, sId} link opens the tracker from that plan session so the saved
    // run auto-ticks it; a bare call (or an event from onClick={openTracker})
    // opens it unlinked. Guard on shape so a click event never counts as a link.
    openTracker: (link?: unknown) => {
      const l = link && typeof link === "object" && "sId" in link && "wNum" in link ? link as { wNum: number; sId: string; findRouteKm?: number } : null;
      setTrackerLink(l ? { wNum: l.wNum, sId: l.sId } : null);
      setTrackerFindKm(l && typeof l.findRouteKm === "number" && l.findRouteKm > 0 ? l.findRouteKm : undefined);
      setShowTracker(true);
    },
    // Open the full-screen per-run analytics view. Guard on shape so a click
    // event (onClick={openRunDetail}) never counts as a run. Keys on `durationSec`
    // (a Run field) rather than `km`, which a PlanSession also has — so a
    // plan-session card wired bare here can't slip through as a Run.
    openRunDetail: (run?: unknown) => {
      const r = run && typeof run === "object" && "durationSec" in run ? run as Run : null;
      if (r) setDetailRun(r);
    },
    openCoach,
    // Manual "scan older runs" for the Integrations settings panel — wider window,
    // bypasses the once-per-session auto throttle.
    scanImportsNow: () => checkWatchRef.current({ days: WATCH_MANUAL_SCAN_DAYS, manual: true })};
  // Record is a center FAB (an action, not a destination), so the row holds the
  // four real destinations, split 2 / 2 around it.
  return (
    <div className="bg-slate-900 text-white min-h-screen" style={{fontFamily:"system-ui,-apple-system,sans-serif"}}>
      {toastP.rendered && <Toast key={toastP.rendered.id} {...toastP.rendered} closing={toastP.closing}/>}
      {celebrate   && <Confetti onDone={() => setCelebrate(false)}/>}
      {onboarding  && <OnboardingWizard settings={settings}
        catalogue={catalogue} addRace={addRace} addEdition={addEdition}
        refreshCatalogue={refreshCatalogue} showToast={showToast}
        onSaveProgress={(partial, step) => saveSettings({...settings, ...partial, onboardStep: step})}
        onComplete={({name, plan, hr, healthAck}) => {
          // `plan` carries the race-shaped fields incl. targetEditionId (set when
          // a catalogue edition was picked, null otherwise). Clear the onboarding
          // scaffolding (onboardStep/intent) so it doesn't linger in the blob.
          const next = {...settings, name, onboarded: true, onboardStep: 0, intent: null, healthAck, ...plan, ...(hr || {})};
          saveSettings(next);
          // Only build a plan if the race was actually set up (the user may have
          // skipped straight to the health gate) — buildPlan needs date+distance.
          if (next.raceDate && next.distanceKm)
            savePlan(buildPlan(next.raceDate, next.goalSec, next.planSessions, next.distanceKm, next.raceElevation, {recentRuns: runs, style: next.planStyle, level: next.trainingLevel}));
          // A catalogue race picked in onboarding is the training target — also
          // surface it in the Races tab as a wishlist participation (the tab lists
          // participations, not the settings target). Skip if already present.
          const joined = findEdition(next.targetEditionId);
          if (joined && !(races.participations || []).some(p => p.editionId === next.targetEditionId)) {
            const ed = joined.edition;
            saveRaces({ ...races, participations: [...(races.participations || []), {
              editionId: ed.id, raceId: joined.raceId, label: editionLabel({ name: String(joined.name) }, ed),
              raceDate: ed.date, distanceKm: ed.distanceKm,
              status: "wishlist", timeSec: null, runId: null, source: "onboarding", notes: "",
            }] });
          }
          setOnboarding(false);
          track("onboarding_completed", {});
        }}/>}
      {showTracker && <LiveRunTracker showToast={showToast} hrMethod={settings.hrMethod} hrOptOut={settings.hrOptOut}
        initialFindKm={trackerFindKm}
        onConfigureHr={() => { setShowTracker(false); openSettings(); }}
        onDeclineHr={() => saveSettings({ ...settings, hrOptOut: true })}
        onFinish={prefill => { setShowTracker(false); goLog({ ...prefill, ...(trackerLink || findOpenPlanSession(plan, prefill.date || "") || {}) }); setTrackerLink(null); setTrackerFindKm(undefined); }}
        onClose={() => { setShowTracker(false); setTrackerLink(null); setTrackerFindKm(undefined); }}/>}
      {showBackup && <BackupModal
        data={{runs, plan, settings, races, userContext, ...(backupRoutes.length ? {routes: backupRoutes} : {})}}
        onClose={() => setShowBackup(false)}/>
      }
      {showRestore && <RestoreModal onRestore={handleRestore}     onClose={() => setShowRestore(false)}/>}
      {showSettings && <SettingsModal
        settings={settings} saveSettings={saveSettings} userContext={userContext} saveUserContext={saveUserContext} showToast={showToast}
        scanImportsNow={shared.scanImportsNow}
        onBackup={()  => { setShowSettings(false); exportData(); }}
        onRestore={() => { setShowSettings(false); setShowRestore(true); }}
        onSignOut={onSignOut}
        onOpenCoach={plan ? () => { setShowSettings(false); openCoach(null, "settings"); } : undefined}
        onDeleteAccount={() => { setShowSettings(false); setShowDeleteAccount(true); }}
        onClose={()   => setShowSettings(false)}/>}
      {showDeleteAccount && <DeleteAccountModal
        onSignOut={onSignOut}
        onClose={() => setShowDeleteAccount(false)}/>}
      {showCoach && plan && (
        // A stale-chunk / transient network failure loading the lazy CoachChat
        // module must not white-screen the app: close the modal and toast instead
        // (unmounting resets the boundary so re-opening retries the import).
        <ChunkLoadBoundary fallback={null}
          onError={() => { setShowCoach(false); showToast(t("coach.errors.transport.offline"), "err"); }}>
          <Suspense fallback={<div className="fixed inset-0 bg-slate-900 z-50"/>}>
            <CoachChat plan={plan} onApplyPlan={applyCoachPlan} sessionContext={coachSession}
              appendUserContext={appendUserContext} showToast={showToast} onClose={() => setShowCoach(false)}/>
          </Suspense>
        </ChunkLoadBoundary>
      )}
      {showRaceForm && <RaceFormModal
        catalogue={catalogue} addRace={addRace} addEdition={addEdition}
        onContributed={refreshCatalogue} showToast={showToast} onCreated={undefined}
        onClose={() => setShowRaceForm(false)}/>}
      {detailRun && <RunDetailModal run={detailRun} settings={settings} onClose={() => setDetailRun(null)}/>}

      <header className="fixed top-0 inset-x-0 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-4 z-20"
        style={{height:"calc(44px + var(--safe-top))", paddingTop:"var(--safe-top)"}}>
        <div className="flex items-center gap-1.5">
          <BrandLogo size={15} className="text-orange-400"/>
          <span className="text-sm font-semibold">Running Coach</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Coach lives here rather than on the Plan tab so it's reachable from
              every view. Gated on `plan` for the same reason the chat itself is
              (`showCoach && plan` below): with no plan there is nothing to
              adjust, so the button would open an empty overlay. Kept on the
              orange accent — next to the settings gear a second muted icon
              reads as a utility, not the product's headline feature. */}
          {plan && (
            // Labelled, not icon-only: a speech bubble alone doesn't say "AI
            // coach". The cog beside it stays bare on purpose — see the comment
            // there. No aria-label: the visible text is the accessible name.
            <button onClick={() => openCoach(null, "header")} title={t("app.header.coachTitle")}
              className="flex items-center gap-1.5 px-2.5 py-1 text-[13px] font-semibold text-orange-400 hover:text-orange-300 rounded-full border border-orange-500/50 bg-orange-500/10 hover:bg-orange-500/20 transition-colors">
              <MessageCircle size={14}/>{t("app.header.coach")}
            </button>
          )}
          <button onClick={openSettings} aria-label={t("app.header.settings")}
            className="flex items-center justify-center text-slate-400 hover:text-white p-1.5 rounded-lg border border-slate-700 hover:border-slate-500 hover:bg-slate-800 transition-colors">
            <Settings size={15}/>
          </button>
        </div>
      </header>

      <div key={tab} className="animate-view-fade" style={{paddingTop:"calc(44px + var(--safe-top))", paddingBottom:"calc(64px + var(--safe-bottom))"}}>
        {tab === "dash"  && <Dashboard  {...shared}/>}
        {tab === "plan"  && <PlanView   {...shared} planPrefill={planPrefill} clearPlanPrefill={() => setPlanPrefill(null)}/>}
        {tab === "log"   && <LogView    {...shared} key={prefillVer} prefill={logPrefill}
          onSaved={() => { if (logPrefill?.wNum != null && logPrefill?.sId) toggleSess(logPrefill.wNum, logPrefill.sId); }}
          onDone={() => { setLogPrefill(null); setTab("dash"); }}/>}
        {tab === "races" && <RacesView {...shared}/>}
        {tab === "progress" && <ProgressView {...shared} initialSub={progressSub} navKey={progressNonce}/>}
      </div>

      <BottomNav
        active={tab}
        className="fixed bottom-0 inset-x-0 z-20"
        onTab={setTab}
        onRecord={() => goLog()}
        onProgress={() => goProgress("stats")}
      />
    </div>
  );
}
