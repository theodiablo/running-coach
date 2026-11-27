import { supabase } from "./supabase";

// The race field: runners from the app doing the same race (docs/race-field.md).
// The only module that touches race_field_members or race_field(). Memberships are
// server-side consent, never in the app_state blob.

export type FieldVisibility = "named" | "count";
export type FieldChoice = FieldVisibility | "none";
// open = at least 3 others joined; count includes the caller when they joined.
export type RaceFieldState = { open: boolean; joined: boolean; count: number | null };
export type MyMembership = { visibility: FieldVisibility; goalSec: number | null };

export const FIELD_CAP = 30;

const parseField = (raw: unknown): RaceFieldState | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const count = typeof r.count === "number" ? r.count : null;
  return { open: r.open === true && count != null, joined: r.joined === true, count };
};

// null = the read failed; callers show the field as closed, never as "not joined".
export async function fetchRaceField(editionId: string): Promise<RaceFieldState | null> {
  try {
    const { data, error } = await supabase.rpc("race_field", { p_edition_id: editionId });
    if (error) return null;
    return parseField(data);
  } catch {
    return null;
  }
}

// undefined = the read failed; null = not a member.
export async function fetchMyMembership(uid: string, editionId: string): Promise<MyMembership | null | undefined> {
  try {
    const { data, error } = await supabase.from("race_field_members")
      .select("visibility, goal_sec").eq("user_id", uid).eq("edition_id", editionId).maybeSingle();
    if (error) return undefined;
    if (!data) return null;
    return { visibility: data.visibility === "named" ? "named" : "count", goalSec: typeof data.goal_sec === "number" ? data.goal_sec : null };
  } catch {
    return undefined;
  }
}

export type FieldWriteResult = "ok" | "limit" | "closed" | "error";

// Insert for a new membership, update for a change: never an upsert (its ON CONFLICT
// would need an update grant on user_id/edition_id, and the cap trigger fires first).
export async function setFieldChoice(uid: string, editionId: string, choice: FieldChoice,
  goalSec: number | null, current: MyMembership | null): Promise<FieldWriteResult> {
  try {
    // A late owed delete must never land after this write and undo it.
    await leavesInFlight;
    if (choice === "none") {
      if (!current) return "ok";
      const { error } = await supabase.from("race_field_members").delete().eq("user_id", uid).eq("edition_id", editionId);
      return error ? "error" : "ok";
    }
    const goal = choice === "named" && goalSec ? Math.round(goalSec) : null;
    if (current) {
      const { data, error } = await supabase.from("race_field_members")
        .update({ visibility: choice, goal_sec: goal }).eq("user_id", uid).eq("edition_id", editionId).select("edition_id");
      if (error) return "error";
      if (data?.length) return "ok";
      // The row went (a removal's delete landed meanwhile): this choice is a fresh join.
    }
    const { error } = await supabase.from("race_field_members")
      .insert({ user_id: uid, edition_id: editionId, visibility: choice, goal_sec: goal });
    if (!error) return "ok";
    // Already a member (joined on another device, or a stale read): this choice is a change.
    if (error.code === "23505") {
      const { data, error: updError } = await supabase.from("race_field_members")
        .update({ visibility: choice, goal_sec: goal }).eq("user_id", uid).eq("edition_id", editionId).select("edition_id");
      return updError || !data?.length ? "error" : "ok";
    }
    const msg = String(error.message || "");
    return /limit reached/.test(msg) ? "limit" : /field closed/.test(msg) ? "closed" : "error";
  } catch {
    return "error";
  }
}

// Keeps a shown goal in step with the race's goal. Only a goal already shown is
// touched: a hidden one (null) stays hidden until the runner turns it on again.
export async function syncFieldGoal(uid: string, editionId: string, goalSec: number | null): Promise<void> {
  try {
    const { error } = await supabase.from("race_field_members")
      .update({ goal_sec: goalSec ? Math.round(goalSec) : null })
      .eq("user_id", uid).eq("edition_id", editionId).eq("visibility", "named").not("goal_sec", "is", null);
    if (error) console.error("field goal sync failed", error.message);
  } catch (e) {
    console.error("field goal sync failed", e instanceof Error ? e.message : "unknown");
  }
}

// Races this device saw leave the runner's list, whose membership it still owes a delete.
// Only this device's own removals are deleted: a list that's merely stale (another device
// added a race and joined) can never undo a membership. Per device, per user.
const leavesKey = (uid: string) => `rc_field_leaves:${uid}`;
const memoryLeaves = new Map<string, string[]>();

// The memory copy is the session's truth (a failed storage write must not hide a removal);
// storage only seeds it and carries it across a killed app.
export function pendingLeaves(uid: string): string[] {
  const held = memoryLeaves.get(uid);
  if (held) return held;
  let seeded: string[] = [];
  try {
    const raw = localStorage.getItem(leavesKey(uid));
    const v: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(v)) seeded = v.filter((x): x is string => typeof x === "string");
  } catch { /* unreadable storage: start empty */ }
  memoryLeaves.set(uid, seeded);
  return seeded;
}

function writeLeaves(uid: string, ids: string[]) {
  memoryLeaves.set(uid, ids);
  try {
    if (ids.length) localStorage.setItem(leavesKey(uid), JSON.stringify(ids));
    else localStorage.removeItem(leavesKey(uid));
  } catch { /* memory copy still covers this session */ }
}

// Records removals and forgets any race that is back on the list.
export function noteListedEditions(uid: string, removed: readonly string[], listed: readonly string[]) {
  const keep = new Set(listed);
  const next = [...new Set([...pendingLeaves(uid), ...removed])].filter(id => !keep.has(id));
  writeLeaves(uid, next);
}

// Deletes the owed memberships, re-checking the list right before the delete so a race
// re-added meanwhile is kept. False when it failed and should be retried.
let leavesInFlight: Promise<unknown> = Promise.resolve();

export function leavePendingFields(uid: string, listed: () => readonly string[]): Promise<boolean> {
  const run = sendLeaves(uid, listed);
  // Chained, not replaced: a join waits for every delete still outstanding.
  leavesInFlight = Promise.all([leavesInFlight, run.catch(() => false)]);
  return run;
}

async function sendLeaves(uid: string, listed: () => readonly string[]): Promise<boolean> {
  const keep = new Set(listed());
  const owed = pendingLeaves(uid).filter(id => !keep.has(id));
  if (!owed.length) { writeLeaves(uid, []); return true; }
  try {
    const { error } = await supabase.from("race_field_members").delete().eq("user_id", uid).in("edition_id", owed);
    if (error) return false;
    const done = new Set(owed);
    writeLeaves(uid, pendingLeaves(uid).filter(id => !done.has(id)));
    return true;
  } catch {
    return false;
  }
}

// Retry schedule for leavePendingFields: on demand, online, foreground, and a 30s→5min
// backoff while a run keeps failing.
const RETRY_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;

export function createFieldReconciler(run: () => Promise<boolean>) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = RETRY_MS;
  let running = false;
  let again = false;
  let stopped = false;
  const clear = () => { if (timer) clearTimeout(timer); timer = null; };
  const go = async () => {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true; clear();
    let ok = false;
    try { ok = await run(); } finally { running = false; }
    if (stopped) return;
    if (again) { again = false; void go(); return; }
    if (ok) { delay = RETRY_MS; return; }
    timer = setTimeout(() => { timer = null; void go(); }, delay);
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  };
  return { run: () => void go(), stop: () => { stopped = true; clear(); } };
}
