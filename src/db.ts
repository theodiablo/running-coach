import { supabase } from "./supabase";
import { UNSYNCED_STATE_KEY, OFFLINE_STATE_KEY } from "./constants";

// Cloud-backed key/value store over the single per-user `app_state` jsonb blob,
// mirrored in an in-memory cache so the app's synchronous db.get/db.set keep
// working; writes debounce into one upsert. See CLAUDE.md "Persistence".
//
// Offline durability rides two localStorage slots:
// - UNSYNCED_STATE_KEY: every flush snapshots the cache first and only a
//   CONFIRMED upsert clears it, so a write that failed offline — or was in
//   flight when the process died — survives to the next boot.
// - OFFLINE_STATE_KEY: a mirror of the last blob the server confirmed (written
//   on every successful load and flush). When the boot read itself fails
//   (offline cold start), initStore boots from this mirror instead of locking
//   the user out, then reconciles with the server once it is reachable again.

let userId: string | null = null;
let cache: Record<string, unknown> = {};
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const RETRY_MS = 30_000;
// Did the cache come from a SUCCESSFUL read of this user's row — or, offline,
// from the local mirror of one? Writes are gated on this, and it is the single
// most important invariant in this file.
//
// flush() replaces the whole `data` blob, so an empty cache upserts as an empty
// blob. If a failed load were allowed to fall back to `{}` and stay writable,
// one aborted request (offline cold start, 15s fetch timeout in supabase.ts)
// would render the app as a brand-new user, and the first db.set — which
// onboarding guarantees — would overwrite every run and plan the user had.
// That is not hypothetical: it happened, silently, and the row is the only copy.
// So: never write a cache we did not populate from real data. The offline
// mirror qualifies — it IS a copy of the user's row — an empty default never does.
let loaded = false;

// Offline-boot bookkeeping. `offlinePending` marks a cache restored from the
// mirror and not yet reconciled against the live row; while set, no upsert may
// happen before a reconcile read. `offlineBase` is the server updated_at the
// mirror was taken against; `lastLocalWriteAt` timestamps the newest local edit
// this session (null = read-only so far), which is what last-write-wins
// compares against a foreign server write.
let offlinePending = false;
let offlineBase = 0;
let lastLocalWriteAt: number | null = null;

// How stale the mirror may be and still boot the app offline. Bounded so a
// long-abandoned device can't resurrect weeks-old data as the current state.
export const OFFLINE_BOOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Whether the store holds a successfully-loaded blob, i.e. whether writes will
// actually persist. Exported for tests and for callers that must not act on an
// unloaded store.
export const isStoreLoaded = () => loaded;

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

export type StoreInitResult = "loaded" | "offline" | "failed";

// Load the user's app_state blob into the cache. Call once after sign-in,
// before rendering the app.
//
// "loaded": the row was read (an absent row is a legitimate read: a genuinely
// new user). "offline": the read failed but the local mirror of a recent
// successful load booted the store — fully usable, reconciled on reconnect.
// "failed": no read and no usable mirror; App.tsx must surface a retryable
// error state, NOT treat it as "no data": the store stays read-only until a
// load succeeds. It never rejects — App.tsx gates rendering on this resolving,
// so a throw would strand the user on the splash spinner.
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
  try {
    const { data, error } = await supabase
      .from("app_state")
      .select("data, updated_at")
      .eq("user_id", uid)
      .maybeSingle();
    if (error) {
      console.error("app_state load failed", error);
      return tryOfflineBoot(uid);
    }
    cache = data && data.data ? data.data : {};
    loaded = true;
    restoreSnapshot(uid, data?.updated_at ?? null);
    writeMirror(data?.updated_at ?? null);
    return "loaded";
  } catch (err) {
    console.error("app_state load threw", err);
    return tryOfflineBoot(uid);
  }
}

// The boot read failed. Instead of locking a signed-in user out, restore the
// last server-confirmed blob from the local mirror — a real copy of this
// user's row, so the never-write-an-unpopulated-cache invariant holds — and
// mark the store offline-pending so the first server contact reconciles before
// anything is upserted. An unsynced snapshot NEWER than the mirror (a run
// saved offline, app killed before reconnecting) supersedes it and still gets
// the flush it was waiting for.
function tryOfflineBoot(uid: string): StoreInitResult {
  const mirror = readMirror();
  if (!mirror || mirror.userId !== uid) return "failed";
  if (Date.now() - mirror.savedAt > OFFLINE_BOOT_MAX_AGE_MS) return "failed";
  if (!mirror.data || typeof mirror.data !== "object") return "failed";
  cache = mirror.data as Record<string, unknown>;
  loaded = true;
  offlinePending = true;
  offlineBase = mirror.serverUpdatedAt || 0;
  const snap = readSnapshot();
  if (snap && snap.userId === uid && snap.savedAt > mirror.savedAt
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

// First server contact after an offline boot. Decides who wins before any
// upsert can replace the row:
// - server row unchanged since the mirror → our state is simply the newest.
// - server advanced (another device wrote): same last-write-wins rule as
//   restoreSnapshot — local edits win only if made after the server write;
//   otherwise the server row is adopted and local edits are dropped.
// - no local edits at all → the server row is adopted unconditionally.
type ReconcileOutcome = "flush" | "adopted" | "unreachable";
async function reconcile(): Promise<ReconcileOutcome> {
  if (!userId) return "adopted";
  try {
    const { data, error } = await supabase
      .from("app_state")
      .select("data, updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return "unreachable";
    const serverAt = data?.updated_at ? Date.parse(data.updated_at) || 0 : 0;
    offlinePending = false;
    if (lastLocalWriteAt != null && (serverAt <= offlineBase || lastLocalWriteAt > serverAt)) {
      return "flush";
    }
    cache = (data && data.data && typeof data.data === "object" ? data.data : {}) as Record<string, unknown>;
    lastLocalWriteAt = null;
    clearOwnSnapshot();
    // Read the baseline BEFORE writeMirror advances it: only remount the app
    // when the adopted row actually differs from what the mirror booted (a
    // foreign write landed while we were offline).
    const advanced = serverAt > offlineBase;
    writeMirror(data?.updated_at ?? null);
    if (advanced) notifyRefresh();
    return "adopted";
  } catch {
    return "unreachable";
  }
}

// A same-user snapshot newer than the server row is an offline write that never
// landed (e.g. a run saved in airplane mode, app killed before reconnecting):
// restore it over the loaded cache and schedule the flush it was waiting for.
// An older-or-equal snapshot was superseded — by its own confirmed upsert or a
// newer write from another device — and is dropped. Only ever called AFTER a
// successful load, so the never-write-an-unloaded-cache invariant is untouched.
function restoreSnapshot(uid: string, serverUpdatedAt: string | null) {
  const snap = readSnapshot();
  if (!snap || snap.userId !== uid) return; // another account's snapshot stays for its owner
  const serverAt = serverUpdatedAt ? Date.parse(serverUpdatedAt) || 0 : 0;
  if (snap.savedAt > serverAt && snap.data && typeof snap.data === "object") {
    cache = snap.data as Record<string, unknown>;
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
    localStorage.setItem(UNSYNCED_STATE_KEY, JSON.stringify({ userId, data: cache, savedAt: Date.now() }));
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
function writeMirror(serverUpdatedAtIso: string | null) {
  if (!userId) return;
  const serverUpdatedAt = serverUpdatedAtIso ? Date.parse(serverUpdatedAtIso) || 0 : 0;
  offlineBase = serverUpdatedAt;
  try {
    localStorage.setItem(OFFLINE_STATE_KEY, JSON.stringify({
      userId, data: cache, serverUpdatedAt, savedAt: Date.now(),
    } satisfies Mirror));
  } catch { /* quota / storage unavailable — offline boot just won't be available */ }
}
function clearMirror() {
  try { localStorage.removeItem(OFFLINE_STATE_KEY); } catch { /* ignore */ }
}

// The signed-in user's id, for direct-table access modules (e.g. src/routes.ts)
// that write rows outside the app_state blob and need to satisfy RLS
// (with check auth.uid() = user_id). Null when signed out.
export function currentUserId() {
  return userId;
}

export function clearStore() {
  // Sign-out: the mirror holds this account's data and must not linger for
  // whoever uses the device next (an offline boot needs a stored auth session
  // anyway, which sign-out also removes). The unsynced snapshot is different —
  // it may be the ONLY copy of a write and is kept for its owner's next sign-in.
  clearMirror();
  userId = null;
  cache = {};
  loaded = false;
  offlinePending = false;
  offlineBase = 0;
  lastLocalWriteAt = null;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

async function flush() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (!userId) return;
  // The guard that makes a failed load non-destructive: this upsert replaces
  // the entire blob, so writing an unloaded cache would erase the row.
  if (!loaded) {
    console.error("app_state save skipped: store was never loaded");
    return;
  }
  // Offline-booted: the row must be read (and possibly adopted) before it may
  // be replaced. Until the server is reachable this loops on the retry timer.
  if (offlinePending) {
    const outcome = await reconcile();
    if (outcome === "unreachable") {
      if (lastLocalWriteAt != null) writeSnapshot();
      scheduleRetry();
      return;
    }
    if (outcome === "adopted") return; // server row won; nothing local left to write
  }
  // Snapshot BEFORE the network attempt: if the process dies mid-flight (or
  // the upsert fails offline) the write still exists on disk for the next boot.
  writeSnapshot();
  const updatedAt = new Date().toISOString();
  const { error } = await supabase.from("app_state").upsert({
    user_id: userId,
    data: cache,
    updated_at: updatedAt,
  });
  if (error) {
    console.error("app_state save failed", error);
    scheduleRetry();
  } else {
    clearSnapshot();
    writeMirror(updatedAt);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }
}

// A failed flush retries on its own — connectivity comes back without the user
// necessarily touching anything, and the cache is only durable in-memory plus
// the snapshot until an upsert is confirmed.
function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; flush(); }, RETRY_MS);
}

// Flush immediately if a debounced write is pending. Safe to call when nothing
// is pending (no-op).
export async function flushNow() {
  if (saveTimer) await flush();
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
  });
  window.addEventListener("pagehide", persistOnExit);
  // Back online: sync a pending or previously-failed write straight away
  // instead of waiting out the retry timer (or the user's next edit) — and
  // reconcile an offline-booted store even when it has nothing to write.
  window.addEventListener("online", () => {
    if (saveTimer || retryTimer || offlinePending) flush();
  });
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
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 600);
  },
};
