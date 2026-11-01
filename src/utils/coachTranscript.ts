// Pure reconstruction of a past coach conversation into the CoachMessage[] the live chat
// renders, from agent_rounds audit rows (read-own RLS). No network or React, so it is
// unit-testable. src/coachHistory.ts fetches rows and feeds them here.
import { diffPlans } from "./coachDiff";
import { describeSession } from "./sessionDesc";
import { fmt, estMin, parseDur } from "./format";
import { TCLR } from "../constants";
import { t } from "../i18n";
import type { Plan, PlanSession } from "../types";

// ── shared chat message shape (the single source; CoachChat imports these) ──
export type MemorySuggestion = { id: string; text: string; status: "pending" | "saved" | "dismissed" };
export type SessionCard = { typeLabel: string; typeColor: string; date: string; title: string; meta: string };
export type CoachMessage = {
  role: "user" | "coach";
  text: string;
  proposal?: { diff: { weekNumber: number; changes: string[] }[] };
  sessionCard?: SessionCard;
  trajectoryId?: string | null;
  roundIndex?: number | null;
  memorySuggestions?: MemorySuggestion[];
};

// One agent_rounds row, trimmed to the columns the transcript needs.
export type TranscriptRound = {
  round_index: number;
  user_feedback: string | null;
  rationale: string | null;
  outcome: "proposed" | "accepted" | "superseded" | "invalid";
  proposed_plan: Plan;
};

// Content signature of a plan for drift detection: every session's id plus the fields a
// coach proposal can change (type/date/km/pace), order-independent. Progress fields
// (done/skipped/runId) are excluded so logging a run isn't a plan edit (see plansDiffer).
function planSignature(plan: Plan | null | undefined): string {
  const rows: string[] = [];
  for (const w of plan?.weeks ?? []) {
    for (const s of (w.sessions ?? [])) {
      rows.push(`${s.id}|${s.type}|${s.date}|${s.km}|${s.pace ?? ""}`);
    }
  }
  return rows.sort().join("\n");
}

// True when two plans differ in any coach-editable session content (add, remove,
// or change) — i.e. applying a proposal built on `a` onto `b` would clobber
// intervening edits.
export function plansDiffer(a: Plan | null | undefined, b: Plan | null | undefined): boolean {
  return planSignature(a) !== planSignature(b);
}

// Round 0's model message is prefixed with an invisible session-context block
// (see CoachChat's sessionPrefix) when the chat was opened about a specific
// session. Strip a single leading "[...]" run so the transcript shows only what
// the runner typed. Leaves plain reports and mid-text brackets untouched.
export function stripSessionPrefix(report: string): string {
  return report.replace(/^\[[^\]]*\]\s*/, "");
}

// The session fields a chat card needs — a full PlanSession qualifies, and so
// does the pseudo-session parseSessionPrefix recovers from a stored report.
export type SessionCardSource = Pick<PlanSession, "type" | "date" | "km" | "desc"> &
  { pace?: number | null; sd?: PlanSession["sd"] };

// The single builder for the "about this session" chat card, shared by the live opening
// message (CoachChat) and reconstructed transcripts. Pace is optional: without it the
// estimate/pace slots are omitted rather than rendered as "--:--".
export function buildSessionCard(s: SessionCardSource): { greeting: string; card: SessionCard } {
  const typeLabel = t("common.types." + s.type, { defaultValue: String(s.type) });
  const est = estMin(Number(s.km), Number(s.pace ?? 0));
  return {
    greeting: t("coach.sessionGreeting", { type: typeLabel, date: fmt.sht(s.date), km: s.km }),
    card: {
      typeLabel,
      typeColor: (TCLR as Record<string, string>)[String(s.type)] || "text-violet-400",
      date: fmt.sht(s.date),
      title: describeSession(s as PlanSession),
      meta: [s.km + " km", est && "~" + est, s.pace ? fmt.pace(s.pace) + "/km" : ""]
        .filter(Boolean).join(" · "),
    },
  };
}

// Recover the session a conversation was opened about from round 0's stored report, which
// begins with the verbatim prefix CoachChat prepends:
// [The runner is asking about this planned session — week N, TYPE on YYYY-MM-DD, K km @ M:SS/km: "desc"]
// Returns null for plain conversations or an unrecognized prefix shape.
export function parseSessionPrefix(report: string): SessionCardSource | null {
  const m = report.match(
    /^\[The runner is asking about this planned session — week \d+, (\S+) on (\d{4}-\d{2}-\d{2}), ([\d.]+) km(?: @ (\d+:\d{2})\/km)?: "([^\]]*)"\]/,
  );
  if (!m) return null;
  return { type: m[1], date: m[2], km: Number(m[3]), pace: m[4] ? parseDur(m[4]) : null, desc: m[5] };
}

// Rebuild the conversation like the live flow: a user bubble and a coach bubble per round,
// and a proposal card on each non-invalid round with a non-empty diff. The diff base folds
// forward as the server's workingPlan does; the OPEN trajectory's latest proposal diffs
// against the live plan, matching what Apply will change.
export function reconstructTranscript(input: {
  trajectoryId: string;
  report: string;
  baseline: Plan | null;
  rounds: TranscriptRound[];
  isOpen: boolean;
  currentPlan?: Plan;
}): CoachMessage[] {
  const { trajectoryId, report, baseline, rounds, isOpen, currentPlan } = input;
  const ordered = [...rounds].sort((a, b) => a.round_index - b.round_index);
  const lastProposedIndex = (() => {
    for (let i = ordered.length - 1; i >= 0; i--) if (ordered[i].outcome !== "invalid") return i;
    return -1;
  })();

  const out: CoachMessage[] = [];

  // A conversation opened about a plan session gets its opening coach message (greeting +
  // session card) rebuilt from the stored prefix; without it the transcript starts mid-
  // conversation. Plain ones start at the user's message. Left unstamped so the flag
  // affordance stays hidden, matching the live greeting.
  const sessionSource = parseSessionPrefix(report);
  if (sessionSource) {
    const { greeting, card } = buildSessionCard(sessionSource);
    out.push({ role: "coach", text: greeting, sessionCard: card });
  }

  let base: Plan | null | undefined = baseline;

  ordered.forEach((round, i) => {
    // User turn.
    const userText = round.round_index === 0 ? stripSessionPrefix(report) : (round.user_feedback ?? "");
    if (userText) out.push({ role: "user", text: userText });

    // Coach turn — stamped so the existing flag affordance works on old rounds.
    const invalid = round.outcome === "invalid";
    const fallback = invalid ? t("coach.fallback.noValidAdjustment") : t("coach.fallback.proposal");
    const coachMsg: CoachMessage = {
      role: "coach",
      text: round.rationale || fallback,
      trajectoryId,
      roundIndex: round.round_index,
    };

    if (!invalid) {
      const diffBase = isOpen && i === lastProposedIndex && currentPlan ? currentPlan : base;
      const diff = diffPlans(diffBase, round.proposed_plan);
      if (diff.length) coachMsg.proposal = { diff };
      base = round.proposed_plan;
    }
    out.push(coachMsg);
  });

  return out;
}
