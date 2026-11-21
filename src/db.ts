import { supabase } from "./supabase";
import { UNSYNCED_STATE_KEY, OFFLINE_STATE_KEY } from "./constants";

// Cloud-backed key/value store over the per-user `app_state` jsonb blob, mirrored in an
// in-memory cache so db.get/db.set stay synchronous; writes debounce into one upsert.
// See CLAUDE.md "Persistence". Offline durability: UNSYNCED_STATE_KEY (snapshot per flush,
// cleared only by a CONFIRMED upsert) and OFFLINE_STATE_KEY (last server-confirmed blob).

let userId: string | null = null;
let cache: Record<string, unknown> = {};
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
// Failed syncs back off (each attempt re-sends the whole blob): a weak link must not keep the
// radio busy every 30s. `online` and a return to the foreground still retry at once.
const RETRY_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;
let retryDelay = RETRY_MS;
// One flush at a time: overlapping upserts on a slow link can land out of order, leaving the
// row on the older blob. A flush asked for mid-flight runs once the current one succeeds.
let flushing: Promise<void> | null = null;
let flushAgain = false;
let flushGen = 0;
// db.set count vs the newest count an upsert (or an adopted server row) has settled: a re-flush
// with nothing new to send would re-stamp the row over a foreign write that landed meanwhile.
let writeSeq = 0;
let settledSeq = 0;
// Bumped by every initStore/clearStore, so a boot read that lands late can tell it is stale.
let bootGen = 0;
// Did the cache come from a SUCCESSFUL read of this user's row (or, offline, its local
// mirror)? Writes are gated on this: flush() replaces the whole `data` blob, so a
// writable empty cache after a failed load would wipe the user's runs and plan.
// Never write a cache we did not populate from real data; an empty default never qualifies.
let loaded = false;

// Offline-boot bookkeeping. `offlinePending`: cache restored from the mirror, not yet
// reconciled (no upsert before a reconcile read). `offlineBase`: server updated_at the
// mirror was taken against. `lastLocalWriteAt`: newest local edit this session (null =
// read-only so far), compared against a foreign server write.
let offlinePending = false;
let offlineBase = 0;
let lastLocalWriteAt: number | null = null;

// How stale the mirror may be and still boot the app offline. Bounded so a
// long-abandoned device can't resurrect weeks-old data as the current state.
export const OFFLINE_BOOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// How long the boot read may hold the splash when a usable mirror exists. On a congested
// start line the read can take the full fetch timeout (behind a token refresh that retries
// for ~30s); past this the mirror opens the app and the read reconciles when it lands.
export const BOOT_READ_BUDGET_MS = 3000;

// Whether the store holds a successfully-loaded blob, i.e. whether writes will
// actually persist. Exported for tests and for callers that must not act on an
// unloaded store.
export const isStoreLoaded = () => loaded;

// Loaded AND not still holding an offline-booted copy that has yet to be
// reconciled with the live row. Anything that WRITES on its own (the plan
// automation in RunningCoach) waits for this: an offline boot's first write
// would race the reconcile that decides which side of a foreign edit wins.
export const isStoreReconciled = () => loaded && !offlinePending;

// Fired when reconcile() replaced the cache under a running app (a newer write
// from another device won). The UI's copies of the data are stale at that
// point; App.tsx subscribes and remounts RunningCoach so it re-reads the store.
type RefreshListener = () => void;
const refreshListeners = new Set<RefreshListener>();
export function subscribeStoreRefresh(cb: RefreshListener) {
  refreshListeners.add(cb);
  return () => { refreshListeners.delete(cb); };
}
const notifyRefresh = () => refreshListeners.forEach(cb => { try { cb(); } catch { /* listener's problem */ } });

// Fired when an offline- or slow-booted store becomes reconciled without a remount, so work
// that waits on isStoreReconciled() (the plan automation) gets its turn this session.
const reconciledListeners = new Set<RefreshListener>();
export function subscribeStoreReconciled(cb: RefreshListener) {
  reconciledListeners.add(cb);
  return () => { reconciledListeners.delete(cb); };
}
const notifyReconciled = () => setTimeout(() => reconciledListeners.forEach(cb => { try { cb(); } catch { /* listener's problem */ } }), 0);

export type StoreInitResult = "loaded" | "offline" | "slow" | "failed";

type RowRead = { ok: true; row: { data?: unknown; updated_at?: string | null } | null } | { ok: false };

// Read the row AS `uid`, or fail. With an expired token whose refresh failed (a weak network;
// auth-js then caches the failure for 60s), supabase-js sends the anon key and RLS answers
// "no row" with no error: taken at face value that is a brand-new account, whose empty blob
// would then be upserted over the real one. So the token is pinned to the request.
async function readRow(uid: string): Promise<RowRead> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token || session.user?.id !== uid) {
      console.error("app_state read skipped: no live session for this user");
      return { ok: false };
    }
    const { data, error } = await supabase
      .from("app_state")
      .select("data, updated_at")
      .eq("user_id", uid)
      .setHeader("Authorization", `Bearer ${session.access_token}`)
      .maybeSingle();
    if (error) {
      console.error("app_state read failed", error);
      return { ok: false };
    }
    return { ok: true, row: data };
  } catch (err) {
    console.error("app_state read threw", err);
    return { ok: false };
  }
}

const usableMirror = (uid: string) => {
  const m = readMirror();
  return !!m && m.userId === uid && Date.now() - m.savedAt <= OFFLINE_BOOT_MAX_AGE_MS
    && !!m.data && typeof m.data === "object";
};

// Load the user's app_state blob into the cache, once after sign-in. "loaded": row read (absent
// = new user). "offline": read failed, the mirror booted. "slow": read outran BOOT_READ_BUDGET_MS,
// the mirror booted and the read reconciles when it lands. "failed": no read, no mirror; read-only
// until App.tsx's retry. Never rejects (App gates rendering on it).
export async function initStore(uid: string): Promise<StoreInitResult> {
  // Flush any write still sitting in the debounce buffer before we replace the
  // cache, otherwise a reload would silently discard unsaved changes.
  await flushNow();
  userId = uid;
  // Drop the outgoing user's data up front. Until the new row lands, the cache
  // must not hold the previous user's blob: with `userId` already switched, any
  // write racing the load would otherwise persist one account's state onto
  // another's row.
  cache = {};
  loaded = false;
  offlinePending = false;
  offlineBase = 0;
  lastLocalWriteAt = null;
  retryDelay = RETRY_MS;
  settledSeq = writeSeq;
  const gen = ++bootGen;
  const read = readRow(uid);
  let budget: ReturnType<typeof setTimeout> | undefined;
  let first = usableMirror(uid)
    ? await Promise.race([read, new Promise<"slow">(res => { budget = setTimeout(() => res("slow"), BOOT_READ_BUDGET_MS); })])
    : await read;
  clearTimeout(budget);
  if (gen !== bootGen) return "failed"; // superseded by a sign-out or another user's boot
  if (first === "slow") {
    if (tryOfflineBoot(uid) === "offline") {
      void read.then(late => { if (late.ok && gen === bootGen && offlinePending) adoptLateRead(late.row); });
      return "slow";
    }
    first = await read;
    if (gen !== bootGen) return "failed";
  }
  if (!first.ok) return tryOfflineBoot(uid);
  const data = first.row;
  const serverData = (data && data.data ? data.data : {}) as Record<string, unknown>;
  cache = serverData;
  loaded = true;
  // Mirror the SERVER blob, not the post-restore cache: restoreSnapshot may
  // put unconfirmed local writes into the cache, and a mirror claiming those
  // as server-confirmed would later reconcile them away as "no local edits".
  // The snapshot itself keeps carrying the unconfirmed data.
  writeMirror(data?.updated_at ?? null, serverData);
  restoreSnapshot(uid, data?.updated_at ?? null);
  return "loaded";
}

// The slow boot read finally landed: it is the reconcile read, so settle against it now
// rather than waiting out the retry timer for a second one.
function adoptLateRead(row: { data?: unknown; updated_at?: string | null } | null) {
  const outcome = reconcileWith(row);
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryDelay = RETRY_MS;
  if (outcome === "flush" && !saveTimer) saveTimer = setTimeout(flush, 600);
}

// The boot read failed: restore the last server-confirmed blob from the local mirror (a
// real copy of the row, so the never-write-an-unpopulated-cache invariant holds) and mark
// offline-pending so the first server contact reconciles before any upsert. A NEWER
// unsynced snapshot supersedes the mirror and still gets its flush.
function tryOfflineBoot(uid: string): StoreInitResult {
  const mirror = readMirror();
  if (!mirror || mirror.userId !== uid) return "failed";
  if (Date.now() - mirror.savedAt > OFFLINE_BOOT_MAX_AGE_MS) return "failed";
  if (!mirror.data || typeof mirror.data !== "object") return "failed";
  cache = mirror.data as Record<string, unknown>;
  loaded = true;
  offlinePending = true;
  offlineBase = mirror.serverUpdatedAt || 0;
  // Same rule as restoreSnapshot: a snapshot newer than the last CONFIRMED
  // server write is an offline save that never landed. Compared against the
  // server baseline, not mirror.savedAt — the mirror may have been rewritten
  // (a later boot) long after the snapshot without ever confirming it.
  const snap = readSnapshot();
  if (snap && snap.userId === uid && snap.savedAt > (mirror.serverUpdatedAt || 0)
    && snap.data && typeof snap.data === "object") {
    cache = snap.data as Record<string, unknown>;
    lastLocalWriteAt = snap.savedAt;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 600);
  }
  // Poll for the server coming back even if no 'online' event ever fires
  // (flaky connectivity looks "online" to the browser throughout).
  scheduleRetry();
  return "offline";
}

// First server contact after an offline boot; decides who wins before any upsert:
// - server unchanged since the mirror: our state is newest.
// - server advanced: last-write-wins as in restoreSnapshot (local wins only if newer).
// - no local edits: adopt the server row.
type ReconcileOutcome = "flush" | "adopted" | "unreachable";
async function reconcile(): Promise<ReconcileOutcome> {
  if (!userId) return "adopted";
  const uid = userId;
  const read = await readRow(uid);
  if (!read.ok) return "unreachable";
  if (userId !== uid) return "unreachable";
  if (!offlinePending) return lastLocalWriteAt != null ? "flush" : "adopted"; // the late boot read settled it
  return reconcileWith(read.row);
}

function reconcileWith(data: { data?: unknown; updated_at?: string | null } | null): "flush" | "adopted" {
  const serverAt = data?.updated_at ? Date.parse(data.updated_at) || 0 : 0;
  offlinePending = false;
  if (lastLocalWriteAt != null && (serverAt <= offlineBase || lastLocalWriteAt > serverAt)) {
    notifyReconciled();
    return "flush";
  }
  cache = (data && data.data && typeof data.data === "object" ? data.data : {}) as Record<string, unknown>;
  lastLocalWriteAt = null;
  settledSeq = writeSeq;
  clearOwnSnapshot();
  // Read the baseline BEFORE writeMirror advances it: only remount the app
  // when the adopted row actually differs from what the mirror booted (a
  // foreign write landed while we were offline).
  const advanced = serverAt > offlineBase;
  writeMirror(data?.updated_at ?? null, cache);
  if (advanced) notifyRefresh();
  else notifyReconciled();
  return "adopted";
}

// A same-user snapshot newer than the server row is an offline write that never landed:
// restore it over the loaded cache and schedule its flush. An older-or-equal one is
// superseded and dropped. Only called AFTER a successful load.
function restoreSnapshot(uid: string, serverUpdatedAt: string | null) {
  const snap = readSnapshot();
  if (!snap || snap.userId !== uid) return; // another account's snapshot stays for its owner
  const serverAt = serverUpdatedAt ? Date.parse(serverUpdatedAt) || 0 : 0;
  if (snap.savedAt > serverAt && snap.data && typeof snap.data === "object") {
    cache = snap.data as Record<string, unknown>;
    lastLocalWriteAt = snap.savedAt;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 600);
  } else {
    clearSnapshot();
  }
}

type Snapshot = { userId: string; data: unknown; savedAt: number };

function readSnapshot(): Snapshot | null {
  try {
    const raw = localStorage.getItem(UNSYNCED_STATE_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw) as Snapshot;
    return snap && typeof snap.userId === "string" && typeof snap.savedAt === "number" ? snap : null;
  } catch { return null; }
}
function writeSnapshot() {
  try {
    // The edit's own time, not now: a re-save must not make an old edit outrank a newer foreign write.
    localStorage.setItem(UNSYNCED_STATE_KEY, JSON.stringify({ userId, data: cache, savedAt: lastLocalWriteAt ?? Date.now() }));
  } catch { /* quota / storage unavailable — the upsert may still succeed */ }
}
function clearSnapshot() {
  try { localStorage.removeItem(UNSYNCED_STATE_KEY); } catch { /* ignore */ }
}
// Reconcile drops a LOSING local snapshot, but the slot may hold another
// account's unsynced write — that one stays for its owner (same rule as
// restoreSnapshot).
function clearOwnSnapshot() {
  const snap = readSnapshot();
  if (snap && snap.userId === userId) clearSnapshot();
}

// The offline-boot mirror: the last blob the server confirmed, plus the
// updated_at it was confirmed at (the reconcile baseline). savedAt bounds how
// stale an offline boot may be.
type Mirror = { userId: string; data: unknown; serverUpdatedAt: number; savedAt: number };

function readMirror(): Mirror | null {
  try {
    const raw = localStorage.getItem(OFFLINE_STATE_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as Mirror;
    return m && typeof m.userId === "string" && typeof m.savedAt === "number" ? m : null;
  } catch { return null; }
}
function writeMirror(serverUpdatedAtIso: string | null, data: Record<string, unknown>) {
  if (!userId) return;
  const serverUpdatedAt = serverUpdatedAtIso ? Date.parse(serverUpdatedAtIso) || 0 : 0;
  offlineBase = serverUpdatedAt;
  try {
    localStorage.setItem(OFFLINE_STATE_KEY, JSON.stringify({
      userId, data, serverUpdatedAt, savedAt: Date.now(),
    } satisfies Mirror));
  } catch { /* quota / storage unavailable — offline boot just won't be available */ }
}
// Real sign-out only (App.tsx, on the SIGNED_OUT auth event): the mirror holds
// account data and must not linger for whoever uses the device next. The
// unsynced snapshot is different — it may be the ONLY copy of a write and is
// kept for its owner's next sign-in.
export function clearOfflineMirror() {
  try { localStorage.removeItem(OFFLINE_STATE_KEY); } catch { /* ignore */ }
}

// The signed-in user's id, for direct-table access modules (e.g. src/routes.ts)
// that write rows outside the app_state blob and need to satisfy RLS
// (with check auth.uid() = user_id). Null when signed out.
export function currentUserId() {
  return userId;
}

export function clearStore() {
  // Deliberately does NOT clear the offline mirror: clearStore also runs on transient
  // null-session states of an offline cold start, and wiping it there would destroy the
  // offline boot. App.tsx calls clearOfflineMirror() on an explicit SIGNED_OUT.
  userId = null;
  cache = {};
  loaded = false;
  offlinePending = false;
  offlineBase = 0;
  lastLocalWriteAt = null;
  bootGen++;
  settledSeq = writeSeq;
  // An attempt still on the wire belongs to the old session (it re-checks userId when it lands).
  flushing = null;
  flushAgain = false;
  flushGen++;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryDelay = RETRY_MS;
}

function flush(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (flushing) {
    // Still on disk if the process dies before the in-flight attempt finishes (pagehide).
    if (loaded && lastLocalWriteAt != null) writeSnapshot();
    flushAgain = true;
    return flushing;
  }
  const gen = ++flushGen;
  flushing = (async () => {
    try {
      let ok: boolean;
      do {
        flushAgain = false;
        ok = await flushOnce(gen);
      } while (ok && flushAgain && writeSeq > settledSeq && gen === flushGen);
    } finally {
      if (gen === flushGen) { flushing = null; flushAgain = false; }
    }
  })();
  return flushing;
}

// One sync attempt. False when it failed and left a retry scheduled.
async function flushOnce(gen: number): Promise<boolean> {
  if (!userId) return true;
  const uid = userId;
  const stale = () => userId !== uid || gen !== flushGen; // the store was cleared or re-booted meanwhile
  // The guard that makes a failed load non-destructive: this upsert replaces
  // the entire blob, so writing an unloaded cache would erase the row.
  if (!loaded) {
    console.error("app_state save skipped: store was never loaded");
    return true;
  }
  // Offline-booted: the row must be read (and possibly adopted) before it may
  // be replaced. Until the server is reachable this loops on the retry timer.
  if (offlinePending) {
    // Snapshot BEFORE the reconcile read: this flush also runs on pagehide, where Android
    // freezes the WebView mid-await and code after reconcile() never runs. reconcile()
    // clears the snapshot again if the server legitimately wins.
    if (lastLocalWriteAt != null) writeSnapshot();
    const outcome = await reconcile();
    if (stale()) return true;
    if (outcome === "unreachable") {
      scheduleRetry();
      return false;
    }
    if (outcome === "adopted") { // server row won; nothing local left to write
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      retryDelay = RETRY_MS;
      return true;
    }
  }
  // Snapshot BEFORE the network attempt: if the process dies mid-flight (or
  // the upsert fails offline) the write still exists on disk for the next boot.
  writeSnapshot();
  const updatedAt = new Date().toISOString();
  const sent = { ...cache }; // db.set mutates the cache in place mid-flight
  const seq = writeSeq;
  const { error } = await supabase.from("app_state").upsert({
    user_id: uid,
    data: sent,
    updated_at: updatedAt,
  });
  if (stale()) return true;
  if (error) {
    console.error("app_state save failed", error);
    scheduleRetry();
    return false;
  }
  // A write that landed mid-flight is not confirmed: keep its snapshot for the next pass.
  if (seq === writeSeq) clearSnapshot();
  settledSeq = Math.max(settledSeq, seq);
  writeMirror(updatedAt, sent); // the upsert just confirmed `sent` as the row
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryDelay = RETRY_MS;
  return true;
}

// A failed flush retries on its own — connectivity comes back without the user
// necessarily touching anything, and the cache is only durable in-memory plus
// the snapshot until an upsert is confirmed.
function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; flush(); }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
}

// Flush immediately if a debounced write is pending, and wait out one already on the wire.
// Safe to call when nothing is pending (no-op).
export async function flushNow() {
  if (saveTimer) await flush();
  else if (flushing) await flushing;
}

// Persist pending writes when the page is being hidden or unloaded, so a
// refresh within the debounce window can't drop the last change. visibilitychange
// is the reliable signal on mobile/desktop; pagehide covers the rest.
if (typeof window !== "undefined") {
  const persistOnExit = () => {
    if (saveTimer) flush();
  };
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistOnExit();
    // Back in front with a sync still owed: try now rather than at the end of a long backoff.
    else if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; flush(); }
  });
  window.addEventListener("pagehide", persistOnExit);
  // Back online: sync a pending or previously-failed write straight away
  // instead of waiting out the retry timer (or the user's next edit) — and
  // reconcile an offline-booted store even when it has nothing to write.
  window.addEventListener("online", () => {
    if (!saveTimer && !retryTimer && !offlinePending) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    flush();
  });
}

// Whether `value` is what the cache holds, or a defaults-extended copy of it
// (shallow). A state copy that fails this predates a row adopted underneath it.
export function isCached(k: string, value: unknown) {
  const held = cache[k];
  if (held === value) return true;
  if (!held || !value || typeof held !== "object" || typeof value !== "object") return false;
  return Object.entries(held).every(([key, v]) => (value as Record<string, unknown>)[key] === v);
}

export const db = {
  async get<T = unknown>(k: string): Promise<T | null> {
    return k in cache ? cache[k] as T : null;
  },
  async set(k: string, v: unknown) {
    cache[k] = v;
    // No successful load means no safe write target: keep the value in memory
    // for the current render, but never schedule a flush that would replace the
    // stored blob with it. App.tsx shows a retry screen in this state, so in
    // practice there is no UI to write from — this is the belt to that braces.
    if (!loaded) return;
    lastLocalWriteAt = Date.now();
    writeSeq++;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 600);
  },
};
