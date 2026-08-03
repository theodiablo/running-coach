import { supabase } from "./supabase";
import { UNSYNCED_STATE_KEY } from "./constants";

// Cloud-backed key/value store over the per-user `app_state` row.
//
// The whole running-coach state lives in a single jsonb blob
// (app_state.data) keyed by user_id. We mirror that blob in an in-memory
// cache so the synchronous-style db.get/db.set the app already uses keep
// working; writes are debounced into a single upsert.
//
// Offline durability: every flush attempt first snapshots the cache to
// localStorage (UNSYNCED_STATE_KEY) and only a CONFIRMED upsert clears it, so
// a write that failed offline — or was in flight when the process died —
// survives to the next boot, where initStore restores it if it is newer than
// the server row (same last-writer-wins the debounced whole-blob upsert
// already implies). A failed flush also retries itself: on the `online` event
// and on a timer, so recovering connectivity syncs without waiting for the
// user's next edit.

let userId: string | null = null;
let cache: Record<string, unknown> = {};
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const RETRY_MS = 30_000;
// Did the cache come from a SUCCESSFUL read of this user's row? Writes are
// gated on this, and it is the single most important invariant in this file.
//
// flush() replaces the whole `data` blob, so an empty cache upserts as an empty
// blob. If a failed load were allowed to fall back to `{}` and stay writable,
// one aborted request (offline cold start, 15s fetch timeout in supabase.ts)
// would render the app as a brand-new user, and the first db.set — which
// onboarding guarantees — would overwrite every run and plan the user had.
// That is not hypothetical: it happened, silently, and the row is the only copy.
// So: never write a cache we did not successfully populate.
let loaded = false;

// Whether the store holds a successfully-loaded blob, i.e. whether writes will
// actually persist. Exported for tests and for callers that must not act on an
// unloaded store.
export const isStoreLoaded = () => loaded;

// Load the user's app_state blob into the cache. Call once after sign-in,
// before rendering the app.
//
// Resolves `true` when the row was read (an absent row is a legitimate read:
// a genuinely new user), `false` when the read failed. It never rejects —
// App.tsx gates rendering on this resolving, so a throw would strand the user
// on the splash spinner. A `false` result must be surfaced as a retryable
// error state, NOT treated as "no data": the store stays read-only until a
// load succeeds.
export async function initStore(uid: string): Promise<boolean> {
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
  try {
    const { data, error } = await supabase
      .from("app_state")
      .select("data, updated_at")
      .eq("user_id", uid)
      .maybeSingle();
    if (error) {
      console.error("app_state load failed", error);
      return false;
    }
    cache = data && data.data ? data.data : {};
    loaded = true;
    restoreSnapshot(uid, data?.updated_at ?? null);
    return true;
  } catch (err) {
    console.error("app_state load threw", err);
    return false;
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

// The signed-in user's id, for direct-table access modules (e.g. src/routes.ts)
// that write rows outside the app_state blob and need to satisfy RLS
// (with check auth.uid() = user_id). Null when signed out.
export function currentUserId() {
  return userId;
}

export function clearStore() {
  userId = null;
  cache = {};
  loaded = false;
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
  // Snapshot BEFORE the network attempt: if the process dies mid-flight (or
  // the upsert fails offline) the write still exists on disk for the next boot.
  writeSnapshot();
  const { error } = await supabase.from("app_state").upsert({
    user_id: userId,
    data: cache,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    console.error("app_state save failed", error);
    scheduleRetry();
  } else {
    clearSnapshot();
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
  // instead of waiting out the retry timer (or the user's next edit).
  window.addEventListener("online", () => {
    if (saveTimer || retryTimer) flush();
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
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 600);
  },
};
