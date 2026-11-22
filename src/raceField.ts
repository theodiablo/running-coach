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
    if (choice === "none") {
      if (!current) return "ok";
      const { error } = await supabase.from("race_field_members").delete().eq("user_id", uid).eq("edition_id", editionId);
      return error ? "error" : "ok";
    }
    const goal = choice === "named" && goalSec ? Math.round(goalSec) : null;
    if (current) {
      const { error } = await supabase.from("race_field_members")
        .update({ visibility: choice, goal_sec: goal }).eq("user_id", uid).eq("edition_id", editionId);
      return error ? "error" : "ok";
    }
    const { error } = await supabase.from("race_field_members")
      .insert({ user_id: uid, edition_id: editionId, visibility: choice, goal_sec: goal });
    if (!error) return "ok";
    const msg = String(error.message || "");
    return /limit reached/.test(msg) ? "limit" : /field closed/.test(msg) ? "closed" : "error";
  } catch {
    return "error";
  }
}

// Keeps a shown goal in step with the race's goal; a no-op unless the runner shows it.
export async function syncFieldGoal(uid: string, editionId: string, goalSec: number | null): Promise<void> {
  try {
    const { error } = await supabase.from("race_field_members")
      .update({ goal_sec: goalSec ? Math.round(goalSec) : null })
      .eq("user_id", uid).eq("edition_id", editionId).eq("visibility", "named");
    if (error) console.error("field goal sync failed", error);
  } catch (e) {
    console.error("field goal sync failed", e);
  }
}

// Deletes every own membership whose race is no longer on the runner's list.
// False when it failed and should be retried.
export async function reconcileFields(uid: string, listedEditionIds: readonly string[]): Promise<boolean> {
  try {
    const { data, error } = await supabase.from("race_field_members").select("edition_id").eq("user_id", uid);
    if (error) return false;
    const keep = new Set(listedEditionIds);
    const stale = (data || []).map(r => String(r.edition_id)).filter(id => !keep.has(id));
    if (!stale.length) return true;
    const { error: delError } = await supabase.from("race_field_members").delete().eq("user_id", uid).in("edition_id", stale);
    return !delError;
  } catch {
    return false;
  }
}

// Retry schedule for reconcileFields: on demand, online, foreground, and a 30s→5min backoff
// while a run keeps failing. Each run re-derives its work, so no pending state is stored.
const RETRY_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;

export function createFieldReconciler(run: () => Promise<boolean>) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = RETRY_MS;
  let running = false;
  let again = false;
  const clear = () => { if (timer) clearTimeout(timer); timer = null; };
  const go = async () => {
    if (running) { again = true; return; }
    running = true; clear();
    let ok = false;
    try { ok = await run(); } finally { running = false; }
    if (again) { again = false; void go(); return; }
    if (ok) { delay = RETRY_MS; return; }
    timer = setTimeout(() => { timer = null; void go(); }, delay);
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  };
  return { run: () => void go(), stop: clear };
}
