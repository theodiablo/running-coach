import { useState, useRef, useEffect } from "react";
import { CoachText } from "../components/CoachText";
import type { CoachLinkTarget } from "../utils/coachLinks";
import { useTranslation, Trans } from "react-i18next";
import { useDismissable } from "../hooks/useDismissable";
import { Loader, MessageSquarePlus, Send, X, Flag, History, ArrowLeft } from "lucide-react";
import { CoachAvatar } from "../components/CoachAvatar";
import { coachPropose, coachCritique, coachConfirm, coachPing, coachUsage, CoachServerError } from "../coach";
import { submitCoachFeedback } from "../coachFeedback";
import { diffPlans } from "../utils/coachDiff";
import { validatePlan } from "../utils/coachValidation";
import { fmt } from "../utils/format";
import { track } from "../telemetry";
import { PRIVACY_URL, DISCLAIMER_URL, COACH_DETAIL_NOTICE_KEY } from "../constants";
import { usageLeft, type CoachUsage } from "../utils/coachUsage";
import { buildSessionCard, type CoachMessage } from "../utils/coachTranscript";
import { CoachHistorySheet } from "./CoachHistorySheet";
import { CoachUsageRing, CoachUsageRingSkeleton } from "./CoachUsageRing";
import type { CoachTrajectorySummary, CoachTranscript, TrajectoryStatus } from "../coachHistory";
import type { CoachSessionContext, Plan } from "../types";


// Tappable starter prompts for the empty chat — teach what the coach can do and
// lower the blank-page barrier. Each just seeds `send` with the phrase.
// Stored as i18n keys (resolved with t() at render) so a runtime language
// switch isn't frozen to the boot language by a module-level t() call.
const COACH_EXAMPLE_KEYS = [
  "coach.examples.fresh",
  "coach.examples.extraDay",
  "coach.examples.moveLongRun",
  "coach.examples.confidence",
];

// Starter chips when the chat is opened about a specific session — steer at that
// session rather than the whole week.
const COACH_SESSION_EXAMPLE_KEYS = [
  "coach.sessionExamples.tooHard",
  "coach.sessionExamples.wrongDay",
  "coach.sessionExamples.easier",
];

// Full-screen coach chat (propose-and-confirm). The user describes what
// happened ("my knee hurts", "I missed the whole week"); the agent proposes a
// validated adjustment to the plan; the user Accepts it or steers with a
// follow-up message. Nothing touches the plan until Accept — and even then the
// accepted plan is re-validated client-side (belt and braces) before
// applyPlan persists it through the normal savePlan path.
// CoachMessage / SessionCard / MemorySuggestion now live in utils/coachTranscript
// (shared with the read-only transcript reconstruction); imported above.
type CoachResult = {
  rationale?: string;
  trajectoryId?: string | null;
  roundIndex?: number;
  memorySuggestions?: { id: string; text: string }[];
  status?: string;
  trajectoryClosed?: boolean;
  changed?: boolean;
  proposedPlan?: Plan;
  usage?: CoachUsage;
};

type CoachChatProps = {
  plan: Plan;
  onApplyPlan: (plan: Plan) => void;
  appendUserContext: (text: string) => boolean;
  showToast: (msg: string, type?: string) => void;
  onClose: () => void;
  // Following an in-app link the coach offered closes the chat and lands on the
  // screen, so the runner does not have to find it themselves.
  onNavigate: (target: CoachLinkTarget) => void;
  // Opening the coach about a specific plan session: the greeting names the
  // session, starter chips steer at it, and its details ride (invisibly) with the
  // user's first message so the model knows exactly which session is meant.
  sessionContext?: CoachSessionContext | null;
};

export function CoachChat({ plan, onApplyPlan, appendUserContext, showToast, onClose, onNavigate, sessionContext }: CoachChatProps) {
  const { t } = useTranslation();
  useDismissable(true, onClose);

  // Localized display strings + a canonical-English context prefix, both derived
  // from the same session so the bubble reads in the user's language while the
  // model gets the stable English `desc`.
  const s = sessionContext?.session;
  const sessionPrefix = s
    ? `[The runner is asking about this planned session — week ${sessionContext!.weekNumber}, ${s.type} on ${s.date}, ${s.km} km${s.pace ? ` @ ${fmt.pace(s.pace)}/km` : ""}: "${s.desc}"]\n\n`
    : "";
  // msg: { role: "user"|"coach", text, proposal?: {plan, diff}, trajectoryId?, roundIndex? }
  // trajectoryId/roundIndex are stamped on every real coach answer (the ones
  // logged server-side to agent_rounds) so it can be flagged as wrong; the
  // greeting, the post-accept "Done", and error bubbles have no round behind
  // them and stay unstamped, which hides the flag affordance on them.
  // The opening greeting — extracted so "Start a new conversation" (after
  // browsing a closed transcript) can reset the chat to exactly this state,
  // including the session card when opened about a specific session.
  const initialMsgs = (): CoachMessage[] => {
    if (!s) return [{ role: "coach", text: t("coach.greeting") }];
    // Same builder reconstructed transcripts use, so live and history renderings
    // of the session opener can't drift.
    const { greeting, card } = buildSessionCard(s);
    return [{ role: "coach", text: greeting, sessionCard: card }];
  };

  const [msgs, setMsgs] = useState<CoachMessage[]>(initialMsgs);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [trajectoryId, setTrajectoryId] = useState<string | null>(null);
  const [flaggingIndex, setFlaggingIndex] = useState(-1);
  const [flagText, setFlagText] = useState("");
  const [flagBusy, setFlagBusy] = useState(false);
  const [flaggedKeys, setFlaggedKeys] = useState<Set<string>>(() => new Set());
  // History browsing + usage meter.
  const [showHistory, setShowHistory] = useState(false);
  // Non-null while a CLOSED conversation is shown read-only (no composer);
  // holds its status so the header can label it. null = live/resumed chat.
  const [viewingClosed, setViewingClosed] = useState<TrajectoryStatus | null>(null);
  const [usage, setUsage] = useState<CoachUsage | null>(null);
  // True until the mount-time usage fetch settles: the footer shows a skeleton
  // in the ring's slot so the ring doesn't pop out of nowhere seconds later.
  const [usageLoading, setUsageLoading] = useState(true);
  // True after resuming an open trajectory whose baseline drifted from the live
  // plan: Apply would clobber intervening edits, so it is hidden (the user is
  // told to start a new conversation to adjust the current plan).
  const [applyBlocked, setApplyBlocked] = useState(false);
  // One-time (per device) transparency note: the coach can read detailed run
  // data (splits/HR digests) when a question calls for it. Dismissal mirrors
  // the other one-shot disclosure flags (HR_BLE_DISCLOSED_KEY et al.).
  const [showDetailNotice, setShowDetailNotice] = useState(() => {
    try { return localStorage.getItem(COACH_DETAIL_NOTICE_KEY) !== "1"; } catch { return true; }
  });
  const dismissDetailNotice = () => {
    setShowDetailNotice(false);
    try { localStorage.setItem(COACH_DETAIL_NOTICE_KEY, "1"); } catch { /* quota — non-fatal */ }
  };
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, busy]);

  const left = usage ? usageLeft(usage) : null;
  const exhausted = left === 0;

  // Tapping a starter chip fills the composer instead of firing straight off, so
  // the user can tweak the phrasing before sending — the chips are prompts, not
  // one-tap sends.
  const fillInput = (text: string) => {
    setInput(text);
    inputRef.current?.focus();
  };

  // Warm the edge function the moment the chat opens so the user's first message
  // lands on an already-booted isolate instead of eating the cold start (the
  // failure mode where round 0 alone times out). Fire-and-forget; coachPing
  // never throws. Also read today's usage for the ring — best-effort, null on an
  // old function / offline, in which case the ring just doesn't render.
  useEffect(() => {
    coachPing();
    let alive = true;
    coachUsage().then(u => { if (alive) { setUsage(u); setUsageLoading(false); } });
    return () => { alive = false; };
  }, []);

  // Absorb a server-carried error onto UI state: refresh the ring if the error
  // carried usage, and drop a stale trajectory so the next send starts fresh
  // (a resumed conversation the server has since abandoned, or a vanished one).
  const absorbServerError = (err: unknown) => {
    if (err instanceof CoachServerError) {
      if (err.usage) { setUsage(err.usage); setUsageLoading(false); }
      if (err.code === "TRAJECTORY_CLOSED" || err.code === "TRAJECTORY_NOT_FOUND") setTrajectoryId(null);
    }
  };

  // Load a conversation picked from the history sheet. An open one resumes in
  // place (composer live); a closed one shows as a read-only transcript.
  const openFromHistory = (traj: CoachTrajectorySummary, transcript: CoachTranscript) => {
    setShowHistory(false);
    setFlaggingIndex(-1);
    setFlagText("");
    setMsgs(transcript.messages);
    if (traj.status === "open") {
      setTrajectoryId(traj.id);
      setViewingClosed(null);
      setApplyBlocked(transcript.applyBlocked);
      track("coach_history_resumed", {});
    } else {
      setTrajectoryId(null);
      setViewingClosed(traj.status);
      setApplyBlocked(false);
    }
  };

  // Leave a read-only transcript and return to a fresh chat.
  const startNewChat = () => {
    setMsgs(initialMsgs());
    setTrajectoryId(null);
    setViewingClosed(null);
    setApplyBlocked(false);
    setFlaggingIndex(-1);
    setFlagText("");
  };

  // Only the most recent proposal is ever confirmable, and only while its
  // trajectory is still open — derived at render (not a per-message flag
  // mutated at every append site), so a stale "Apply" button can't survive an
  // append path that forgets to reset it.
  let lastProposalIndex = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].proposal) { lastProposalIndex = i; break; }

  const coachMsg = (res: CoachResult, fallbackText: string): CoachMessage => ({
    role: "coach",
    text: res.rationale || fallbackText,
    trajectoryId: res.trajectoryId,
    roundIndex: res.roundIndex,
    memorySuggestions: (res.memorySuggestions || []).map(s => ({ ...s, status: "pending" })),
  });

  const applyCoachResult = (res: CoachResult) => {
    track("coach_proposal", { status: res.status, round: res.roundIndex });
    if (res.usage) { setUsage(res.usage); setUsageLoading(false); }
    if (res.status === "no_valid_adjustment") {
      setTrajectoryId(res.trajectoryClosed ? null : res.trajectoryId ?? null);
      setMsgs(m => [...m, coachMsg(res, t("coach.fallback.noValidAdjustment"))]);
    } else if (!res.changed) {
      // No plan change proposed (an informational answer). The trajectory is
      // still OPEN server-side, so keep its id: a follow-up must continue this
      // same conversation as a critique, not start a fresh propose — otherwise
      // a purely informational two-message chat gets split into two separate
      // conversations in history. There's no proposal card here, so keeping the
      // id can't surface a stale Apply button (a `changed:false` round means the
      // working plan still equals the original baseline — no confirmable edit).
      setTrajectoryId(res.trajectoryId ?? null);
      setMsgs(m => [...m, coachMsg(res, t("coach.fallback.noChangeNeeded"))]);
    } else {
      setTrajectoryId(res.trajectoryId ?? null);
      if (!res.proposedPlan) throw new Error(t("coach.errors.noProposedPlan"));
      const diff = diffPlans(plan, res.proposedPlan);
      setMsgs(m => [...m, { ...coachMsg(res, t("coach.fallback.proposal")), proposal: { diff } }]);
    }
  };

  const send = async (preset?: string | unknown) => {
    // `preset` comes from an example chip; a bare click/keydown passes an event,
    // so only treat a real string as an override and otherwise read the input.
    const text = (typeof preset === "string" ? preset : input).trim();
    if (!text || busy || exhausted) return;
    // Count genuine coach interactions — a user actually sending a message.
    // Never the message text; just whether it opens a chat or follows up on an
    // already-open trajectory (a proposal round). Consent-gated in track().
    track("coach_message_sent", { followUp: !!trajectoryId });
    setInput("");
    setMsgs(m => [...m, { role: "user", text }]);
    setBusy(true);
    try {
      // Round 0 opened about a session: prepend the (invisible) session context
      // to what the model sees while the bubble shows only what the user typed.
      // Follow-ups send bare text — the server keeps round 0's report in context.
      const outbound = !trajectoryId && sessionPrefix ? sessionPrefix + text : text;
      const res = trajectoryId ? await coachCritique(trajectoryId, text) : await coachPropose(outbound);
      applyCoachResult(res);
    } catch (err) {
      absorbServerError(err);
      setMsgs(m => [...m, { role: "coach", text: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setBusy(false);
    }
  };

  // The server's confirm re-validates and returns the authoritative plan — the
  // proposal card is display-only.
  const accept = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!trajectoryId) throw new Error(t("coach.errors.noProposalReady"));
      const { plan: accepted, baseline: serverBaseline } = await coachConfirm(trajectoryId);
      if (!accepted) throw new Error(t("coach.errors.confirmNoPlan"));
      // Clear before the client check: the server already accepted the trajectory,
      // so the Apply button must not survive a client-side validation failure
      // (which would let a retry call coachConfirm on an already-accepted trajectory).
      // Use the server's stored baseline so the waiver set matches what the server used.
      setTrajectoryId(null);
      const check = validatePlan(accepted, { baseline: serverBaseline ?? plan });
      if (!check.ok) throw new Error(t("coach.errors.revalidateFailed"));
      onApplyPlan(accepted);
      track("coach_plan_applied", {});
      setMsgs(m => [...m, { role: "coach", text: t("coach.fallback.applied") }]);
      showToast(t("coach.toast.planAdjusted"));
    } catch (err) {
      absorbServerError(err);
      setMsgs(m => [...m, { role: "coach", text: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setBusy(false);
    }
  };

  // Flagging is FREE and only records feedback (an insert into coach_feedback) —
  // it never fires a billable critique round. That keeps the usage popover's
  // promise ("flagging answers don't count") honest and can't be used to spend a
  // round while the composer is disabled at the daily limit. A user who wants the
  // coach to actually revise the answer types a follow-up in the composer, which
  // visibly counts.
  const submitFlag = async (m: CoachMessage) => {
    const correction = flagText.trim();
    if (!correction || flagBusy) return;
    setFlagBusy(true);
    try {
      if (!m.trajectoryId || m.roundIndex == null) throw new Error(t("coach.errors.noResponseToFlag"));
      await submitCoachFeedback({ trajectoryId: m.trajectoryId, roundIndex: m.roundIndex, correction });
      track("coach_feedback_submitted", { roundIndex: m.roundIndex });
      setFlaggedKeys(prev => new Set(prev).add(`${m.trajectoryId}:${m.roundIndex}`));
      showToast(t("coach.toast.feedbackSent"));
    } catch {
      showToast(t("coach.toast.feedbackFailed"));
    } finally {
      setFlagBusy(false);
      setFlaggingIndex(-1);
      setFlagText("");
    }
  };

  const saveMemorySuggestion = (msgIndex: number, suggestionId: string, text: string) => {
    const saved = appendUserContext(text);
    setMsgs(cur => cur.map((m, i) => i !== msgIndex ? m : {
      ...m,
      memorySuggestions: (m.memorySuggestions || []).map(s => s.id === suggestionId ? { ...s, status: "saved" } : s),
    }));
    showToast(saved ? t("coach.memory.saved") : t("coach.toast.memoryDuplicate"));
  };

  const dismissMemorySuggestion = (msgIndex: number, suggestionId: string) => {
    setMsgs(cur => cur.map((m, i) => i !== msgIndex ? m : {
      ...m,
      memorySuggestions: (m.memorySuggestions || []).map(s => s.id === suggestionId ? { ...s, status: "dismissed" } : s),
    }));
  };

  return (
    <div className="fixed inset-0 bg-slate-900 z-50 flex flex-col animate-slide-up">
      <div className="flex justify-between items-center px-2 border-b border-slate-800 flex-shrink-0"
        style={{height:"calc(44px + var(--safe-top))", paddingTop:"var(--safe-top)"}}>
        {viewingClosed ? (
          <div className="flex items-center gap-1 min-w-0">
            <button onClick={() => setShowHistory(true)} aria-label={t("common.back")} className="text-slate-400 hover:text-white p-1.5"><ArrowLeft size={18}/></button>
            <span className="text-[10px] font-bold uppercase tracking-wide"
              style={{ color: viewingClosed === "accepted" ? "#34d399" : "#64748b" }}>
              {t("coach.history.status." + viewingClosed)}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 pl-1.5">
            <CoachAvatar size={15} className="text-orange-400"/>
            <span className="text-sm font-semibold">{t("coach.title")}</span>
          </div>
        )}
        <div className="flex items-center gap-0.5">
          {/* Back to a fresh chat from any ongoing conversation — a resumed OPEN
              trajectory otherwise has no way out (the closed-transcript footer
              button doesn't render there, and closing the whole coach is the
              only reset). Hidden on the untouched initial state, where it
              would be a no-op. */}
          {(viewingClosed !== null || trajectoryId !== null || msgs.length > 1) && (
            <button onClick={startNewChat} aria-label={t("coach.history.startNew")} className="text-slate-400 hover:text-white p-1.5"><MessageSquarePlus size={17}/></button>
          )}
          <button onClick={() => setShowHistory(true)} aria-label={t("coach.history.aria")} className="text-slate-400 hover:text-white p-1.5"><History size={17}/></button>
          <button onClick={onClose} aria-label={t("common.close")} className="text-slate-400 hover:text-white p-1.5"><X size={18}/></button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3 max-w-lg w-full mx-auto">
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start gap-2"}>
            {/* Avatar on the first bubble of each coach group; a spacer keeps
                follow-up bubbles aligned under it. */}
            {m.role !== "user" && (
              i === 0 || msgs[i - 1].role === "user"
                ? <CoachAvatar chip className="w-7 h-7 mt-0.5" size={14}/>
                : <div className="w-7 flex-shrink-0" aria-hidden/>
            )}
            <div className={"rounded-2xl px-3.5 py-2.5 text-sm max-w-[85%] " +
              (m.role === "user"
                ? "whitespace-pre-wrap bg-orange-500/20 border border-orange-500/30"
                : "bg-slate-800 border border-slate-700")}>
              {m.role === "user" ? m.text : <CoachText text={m.text} onNavigate={onNavigate}/>}
              {m.sessionCard && (
                <div className="mt-3 pt-3 border-t border-slate-700">
                  <div className="flex items-center gap-2">
                    <span className={"text-xs font-bold uppercase " + m.sessionCard.typeColor}>{m.sessionCard.typeLabel}</span>
                    <span className="text-xs text-slate-500">{m.sessionCard.date}</span>
                  </div>
                  <p className="text-sm font-semibold text-slate-200 leading-snug mt-0.5">{m.sessionCard.title}</p>
                  <p className="text-xs text-slate-400 mt-0.5">{m.sessionCard.meta}</p>
                </div>
              )}
              {m.proposal && (
                <div className="mt-3 pt-3 border-t border-slate-700 space-y-2">
                  {m.proposal.diff.map(w => (
                    <div key={w.weekNumber}>
                      <p className="text-xs font-semibold text-slate-300">{t("coach.week", { num: w.weekNumber })}</p>
                      {w.changes.map((c, j) => <p key={j} className="text-xs text-slate-400">· {c}</p>)}
                    </div>
                  ))}
                  {i === lastProposalIndex && trajectoryId && (
                    applyBlocked ? (
                      <p className="mt-1 text-xs text-amber-400/90 leading-relaxed">{t("coach.history.planChanged")}</p>
                    ) : (
                      <button onClick={accept} disabled={busy}
                        className="w-full mt-1 bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-white py-2 rounded-xl text-sm font-semibold transition-colors">
                        {t("coach.apply")}
                      </button>
                    )
                  )}
                </div>
              )}
              {(m.memorySuggestions || []).filter(s => s.status !== "dismissed").map(s => (
                <div key={s.id} className="mt-3 pt-3 border-t border-slate-700 space-y-2">
                  <p className="text-xs font-semibold text-slate-300">{t("coach.memory.prompt")}</p>
                  <p className="text-xs text-slate-400 whitespace-pre-wrap">{s.text}</p>
                  {s.status === "saved" ? (
                    <p className="text-xs text-emerald-400">{t("coach.memory.saved")}</p>
                  ) : (
                    <div className="flex gap-2">
                      <button onClick={() => saveMemorySuggestion(i, s.id, s.text)}
                        className="text-xs bg-orange-500 hover:bg-orange-600 text-white px-2.5 py-1 rounded-lg transition-colors">
                        {t("coach.memory.save")}
                      </button>
                      <button onClick={() => dismissMemorySuggestion(i, s.id)}
                        className="text-xs text-slate-400 hover:text-white px-2.5 py-1 rounded-lg transition-colors">
                        {t("common.notNow")}
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {m.trajectoryId != null && m.roundIndex != null && (
                flaggedKeys.has(`${m.trajectoryId}:${m.roundIndex}`) ? (
                  <p className="mt-2 text-xs text-slate-500">{t("coach.flag.thanks")}</p>
                ) : flaggingIndex === i ? (
                  <div className="mt-2 pt-2 border-t border-slate-700 space-y-1.5">
                    <textarea value={flagText} onChange={e => setFlagText(e.target.value)}
                      placeholder={t("coach.flag.placeholder")} rows={2} autoFocus
                      className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-orange-400 placeholder-slate-500 resize-none"/>
                    <div className="flex gap-2">
                      <button onClick={() => submitFlag(m)} disabled={flagBusy || busy || !flagText.trim()}
                        className="text-xs bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-white px-2.5 py-1 rounded-lg transition-colors">
                        {t("coach.send")}
                      </button>
                      <button onClick={() => { setFlaggingIndex(-1); setFlagText(""); }} disabled={flagBusy}
                        className="text-xs text-slate-400 hover:text-white px-2.5 py-1 rounded-lg transition-colors">
                        {t("common.cancel")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => { setFlaggingIndex(i); setFlagText(""); }}
                    className="mt-2 flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors">
                    <Flag size={11}/> {t("coach.flag.cta")}
                  </button>
                )
              )}
            </div>
          </div>
        ))}
        {msgs.length === 1 && !busy && !exhausted && (
          <div className="flex flex-wrap gap-2 pt-1">
            {(sessionContext ? COACH_SESSION_EXAMPLE_KEYS : COACH_EXAMPLE_KEYS).map(k => (
              <button key={k} onClick={() => fillInput(t(k))}
                className="text-xs text-slate-300 bg-slate-800 border border-slate-700 hover:border-orange-400/60 hover:text-white rounded-full px-3 py-1.5 transition-colors">
                {t(k)}
              </button>
            ))}
          </div>
        )}
        {/* Not gated on the empty state: a resumed conversation (history sheet
            restores msgs.length > 1) must still surface the privacy notice
            until the user dismisses it on this device. */}
        {showDetailNotice && (
          <div className="flex items-start gap-2 text-[11px] text-slate-400 bg-slate-800/60 border border-slate-700/60 rounded-lg px-3 py-2">
            <span className="flex-1">{t("coach.detailNotice.text")}</span>
            <button onClick={dismissDetailNotice}
              className="text-slate-300 hover:text-white font-medium shrink-0">
              {t("coach.detailNotice.gotIt")}
            </button>
          </div>
        )}
        {busy && <div className="flex items-center gap-2 text-slate-400 text-xs">
          <CoachAvatar chip className="w-7 h-7" size={14}/>
          <Loader size={14} className="animate-spin"/>
          {t("coach.thinking")}
        </div>}
        <div ref={endRef}/>
      </div>

      <div className="border-t border-slate-800 p-3 flex-shrink-0" style={{paddingBottom:"calc(0.75rem + var(--safe-bottom))"}}>
        <div className="max-w-lg mx-auto flex items-end gap-2 mb-2">
          <div className="flex-1 text-[11px] text-slate-500">
            {/* Children stay in one text flow so the <1>/<3> element indices in the
                dictionary string line up with the two anchors. */}
            <Trans i18nKey="coach.footer">Your coach uses your message, plan, recent runs, and saved memory to answer. See our <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-orange-300 underline underline-offset-2">privacy policy</a> and <a href={DISCLAIMER_URL} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-orange-300 underline underline-offset-2">safety note</a>.</Trans>
          </div>
          {usageLoading ? <CoachUsageRingSkeleton/> : usage && <CoachUsageRing usage={usage}/>}
        </div>
        {viewingClosed ? (
          <div className="max-w-lg mx-auto">
            <p className="text-[11px] text-slate-500 mb-2 text-center">{t("coach.history.readOnly")}</p>
            <button onClick={startNewChat}
              className="w-full bg-orange-500 hover:bg-orange-600 text-white py-2.5 rounded-xl text-sm font-semibold transition-colors">
              {t("coach.history.startNew")}
            </button>
          </div>
        ) : (
          <>
            {exhausted && (
              <p className="max-w-lg mx-auto text-[11px] text-amber-400 mb-2">{t("coach.usage.limitReached")}</p>
            )}
            <div className="max-w-lg mx-auto flex gap-2">
              <input id="coach-message" name="coach-message" ref={inputRef} aria-label={t("coach.input.aria")} value={input} onChange={e => setInput(e.target.value)}
                autoFocus={!!sessionContext}
                disabled={exhausted}
                onKeyDown={e => { if (e.key === "Enter") send(); }}
                placeholder={trajectoryId ? t("coach.input.placeholderFollowUp") : t("coach.input.placeholder")}
                className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-orange-400 placeholder-slate-500 disabled:opacity-50"/>
              <button onClick={send} disabled={busy || !input.trim() || exhausted} aria-label={t("coach.send")}
                className="bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-white px-4 rounded-xl transition-colors">
                <Send size={16}/>
              </button>
            </div>
          </>
        )}
      </div>

      {showHistory && (
        <CoachHistorySheet currentPlan={plan} onClose={() => setShowHistory(false)} onOpen={openFromHistory} showToast={showToast}/>
      )}
    </div>
  );
}
