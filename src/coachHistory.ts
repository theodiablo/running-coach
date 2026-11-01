// Access module for coach conversation history (like src/routes.ts / src/races.ts: direct
// table queries, not the app_state blob). Reads the audit rows coach-agent writes to
// agent_trajectories / agent_rounds; read-own RLS SELECT already covers both.
import { supabase } from "./supabase";
import { reconstructTranscript, plansDiffer, type CoachMessage, type TranscriptRound } from "./utils/coachTranscript";
import type { Plan } from "./types";

export type TrajectoryStatus = "open" | "accepted" | "abandoned" | "no_valid_adjustment";

export type CoachTrajectorySummary = {
  id: string;
  status: TrajectoryStatus;
  createdAt: string;
  updatedAt: string;
  preview: string; // round-0 report, session prefix left intact for the sheet to strip
};

// Only surface conversations from the last 30 days (matches the sheet's "last
// 30 days" hint) — older audit rows stay in the DB for evals but aren't listed.
const HISTORY_WINDOW_DAYS = 30;

// Round-0 report can carry the invisible "[...]" session-context prefix; strip
// it for the one-line preview so the row reads as what the runner typed.
function previewText(report: unknown): string {
  return String(report ?? "").replace(/^\[[^\]]*\]\s*/, "").trim();
}

type ListRow = {
  id: string;
  status: TrajectoryStatus;
  created_at: string;
  updated_at: string;
  agent_rounds: { preview: string | null }[] | null;
};

// List the caller's recent conversations, newest first. The !inner embed +
// round_index=0 filter fetches only the round-0 report text (never the whole
// input_context, which embeds recentRuns + plan snapshots) in one query, and
// naturally drops any trajectory that somehow has no round 0.
export async function listCoachTrajectories(limit = 50): Promise<CoachTrajectorySummary[]> {
  const since = new Date(Date.now() - HISTORY_WINDOW_DAYS * 86400_000).toISOString();
  const { data, error } = await supabase
    .from("agent_trajectories")
    .select("id, status, created_at, updated_at, agent_rounds!inner(preview:input_context->>report)")
    .eq("agent_rounds.round_index", 0)
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as ListRow[]).map((r) => ({
    id: r.id,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    preview: previewText(r.agent_rounds?.[0]?.preview),
  }));
}

export type CoachTranscript = {
  messages: CoachMessage[];
  // True only for a resumed OPEN trajectory whose stored baseline no longer
  // matches the live plan: the proposal would apply a snapshot built on a stale
  // baseline and silently clobber intervening edits, so CoachChat hides Apply.
  applyBlocked: boolean;
};

// Reconstruct a conversation's messages for display / resume. Two slim queries:
// the rounds (only the columns the transcript needs) and round 0's report +
// baseline plan (JSON-path selects, so recentRuns never ships to the client).
export async function fetchCoachTranscript(
  trajectoryId: string,
  opts: { isOpen: boolean; currentPlan?: Plan },
): Promise<CoachTranscript> {
  const [roundsRes, r0Res] = await Promise.all([
    supabase
      .from("agent_rounds")
      .select("round_index, user_feedback, rationale, outcome, proposed_plan")
      .eq("trajectory_id", trajectoryId)
      .order("round_index", { ascending: true }),
    supabase
      .from("agent_rounds")
      .select("report:input_context->>report, baseline:input_context->plan")
      .eq("trajectory_id", trajectoryId)
      .eq("round_index", 0)
      .maybeSingle(),
  ]);
  if (roundsRes.error) throw roundsRes.error;
  if (r0Res.error) throw r0Res.error;
  const rounds = roundsRes.data ?? [];
  if (!rounds.length || !r0Res.data) throw new Error("conversation not found");

  const baseline = ((r0Res.data as { baseline?: Plan | null }).baseline) ?? null;
  const messages = reconstructTranscript({
    trajectoryId,
    report: String((r0Res.data as { report?: unknown }).report ?? ""),
    baseline,
    rounds: rounds as unknown as TranscriptRound[],
    isOpen: opts.isOpen,
    currentPlan: opts.currentPlan,
  });
  const applyBlocked = opts.isOpen && !!baseline && !!opts.currentPlan && plansDiffer(baseline, opts.currentPlan);
  return { messages, applyBlocked };
}
