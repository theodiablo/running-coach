import { supabase } from "./supabase";

// Cloud-backed key/value store over the per-user `app_state` row.
//
// The whole running-coach state lives in a single jsonb blob
// (app_state.data) keyed by user_id. We mirror that blob in an in-memory
// cache so the synchronous-style db.get/db.set the app already uses keep
// working; writes are debounced into a single upsert.

let userId: string | null = null;
let cache: Record<string, unknown> = {};
let saveTimer: ReturnType<typeof setTimeout> | null = null;
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
      .select("data")
      .eq("user_id", uid)
      .maybeSingle();
    if (error) {
      console.error("app_state load failed", error);
      return false;
    }
    cache = data && data.data ? data.data : {};
    loaded = true;
    return true;
  } catch (err) {
    console.error("app_state load threw", err);
    return false;
  }
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
  const { error } = await supabase.from("app_state").upsert({
    user_id: userId,
    data: cache,
    updated_at: new Date().toISOString(),
  });
  if (error) console.error("app_state save failed", error);
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
