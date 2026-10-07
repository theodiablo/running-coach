import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Check, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX, X } from "lucide-react";
import { StretchFigure } from "../components/StretchFigure";
import { StretchBetaNote } from "../components/StretchBetaNote";
import { ConfirmButtons, ModalOverlay } from "../components/ModalPrimitives";
import { useDismissable } from "../hooks/useDismissable";
import { useKeepAwake } from "../hooks/useKeepAwake";
import { primeStretchCues, releaseCues, stretchCue } from "../cues";
import { MOVE_KIND } from "../stretch/routines";
import type { Routine } from "../stretch/routines";
import { backTarget, isSideSwitch, positionAt, routineSteps, stepStartMs, totalMs } from "../utils/stretchEngine";
import type { StretchPosition, StretchSide } from "../utils/stretchEngine";

type StretchPlayerProps = {
  routine: Routine;
  voice: boolean;
  onVoiceChange: (on: boolean) => void;
  weekCount: number;
  /** Fires once at the end, with the seconds actually played, if that is a real session. */
  onComplete: (sec: number) => void;
  /** Back to the routine, before the end. */
  onClose: () => void;
  /** After the done screen. */
  onFinish: () => void;
  onFeedback?: () => void;
};

// Paused state keeps the elapsed time; running keeps the wall-clock instant the
// routine would have started, so a screen that slept reads the right step.
type Clock = { startedAt: number | null; elapsed: number };

// Less than this actually played (a tap-through on Skip) is not a session.
const MIN_LOGGED_SEC = 60;
// A blip each second over a move's last few, before the change beep.
const COUNTDOWN_SEC = 5;
const RING_R = 46;
const RING_C = 2 * Math.PI * RING_R;

function LeaveConfirm({ onStop, onKeep }: { onStop: () => void; onKeep: () => void }) {
  const { t } = useTranslation();
  useDismissable(true, onKeep);
  return (
    <ModalOverlay>
      <div className="bg-slate-800 rounded-2xl p-5 max-w-sm w-full space-y-3">
        <h3 className="text-lg font-bold text-white">{t("stretch.player.leaveTitle")}</h3>
        <p className="text-sm text-slate-300">{t("stretch.player.leaveBody")}</p>
        <ConfirmButtons onCancel={onKeep} onAccept={onStop}
          cancelLabel={t("stretch.player.leaveKeep")} acceptLabel={t("stretch.player.leaveStop")}/>
      </div>
    </ModalOverlay>
  );
}

export function StretchPlayer({ routine, voice, onVoiceChange, weekCount, onComplete, onClose, onFinish, onFeedback }: StretchPlayerProps) {
  const { t, i18n } = useTranslation();
  const steps = useMemo(() => routineSteps(routine), [routine]);
  const [clock, setClock] = useState<Clock>({ startedAt: null, elapsed: 0 });
  const [now, setNow] = useState(() => Date.now());
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [done, setDone] = useState(false);
  const [playedSec, setPlayedSec] = useState(0);
  const announced = useRef("");
  const ticked = useRef("");
  const finished = useRef(false);
  // Wall-clock time spent running, not the routine's planned length.
  const played = useRef({ ms: 0, since: null as number | null });
  const resumeAfterConfirm = useRef(false);
  const running = clock.startedAt !== null;
  const elapsed = running ? now - (clock.startedAt as number) : clock.elapsed;
  const pos = positionAt(steps, done ? totalMs(steps) : elapsed);
  const step = steps[pos.index];
  const name = (move: string) => t(`stretch.moves.${move}.name`);
  const sideWord = (side: StretchSide) => t(side === "left" ? "stretch.player.sideLeft" : "stretch.player.sideRight");
  const routineName = t(`stretch.routines.${routine.id}.name`);

  useKeepAwake(running);
  // Once done, the last cue is left to finish on its own.
  useEffect(() => () => { if (!finished.current) releaseCues(); }, []);

  const startPlayed = (t0: number) => { played.current.since = t0; };
  const stopPlayed = (t0: number) => {
    if (played.current.since !== null) played.current.ms += t0 - played.current.since;
    played.current.since = null;
  };

  const announce = (p: StretchPosition) => {
    const key = `${p.index}:${p.phase}`;
    if (key === announced.current) return;
    announced.current = key;
    if (p.phase === "hold") { stretchCue("info"); return; }
    const s = steps[p.index];
    let text: string | undefined;
    if (voice) {
      const nm = name(s.move);
      if (isSideSwitch(steps, p.index)) text = t("stretch.player.speak.switch");
      else if (p.index === 0) text = s.side ? t("stretch.player.speak.startSide", { name: nm, side: sideWord(s.side) }) : t("stretch.player.speak.start", { name: nm });
      else text = s.side ? t("stretch.player.speak.nextSide", { name: nm, side: sideWord(s.side) }) : t("stretch.player.speak.next", { name: nm });
    }
    stretchCue("step", text, i18n.language || "en");
  };

  const countdown = (p: StretchPosition) => {
    const left = Math.ceil(p.remainingMs / 1000);
    if (p.phase !== "hold" || left > COUNTDOWN_SEC || left < 1 || left * 1000 >= p.phaseMs) return;
    const key = `${p.index}:${left}`;
    if (key === ticked.current) return;
    ticked.current = key;
    stretchCue("info");
  };

  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    stopPlayed(Date.now());
    const sec = Math.round(played.current.ms / 1000);
    setPlayedSec(sec);
    setClock({ startedAt: null, elapsed: totalMs(steps) });
    setDone(true);
    stretchCue("done", voice ? t("stretch.player.speak.done") : undefined, i18n.language || "en");
    if (sec >= MIN_LOGGED_SEC) onComplete(sec);
  };

  const onTick = useEffectEvent(() => {
    const t0 = Date.now();
    const p = positionAt(steps, t0 - (clock.startedAt ?? t0));
    if (p.done) finish();
    else { announce(p); countdown(p); setNow(t0); }
  });

  useEffect(() => {
    if (!running) return;
    const id = setInterval(onTick, 250);
    return () => clearInterval(id);
  }, [running]);

  const seek = (ms: number) => {
    const t0 = Date.now();
    announced.current = "";
    ticked.current = "";
    setNow(t0);
    if (running) {
      setClock({ startedAt: t0 - ms, elapsed: 0 });
      announce(positionAt(steps, ms));
    } else setClock({ startedAt: null, elapsed: ms });
  };

  const pause = (t0: number) => {
    stopPlayed(t0);
    setClock({ startedAt: null, elapsed: t0 - (clock.startedAt as number) });
  };

  const resume = (t0: number) => {
    primeStretchCues();
    startPlayed(t0);
    setNow(t0);
    setClock({ startedAt: t0 - clock.elapsed, elapsed: 0 });
    announce(positionAt(steps, clock.elapsed));
  };

  const togglePlay = () => {
    const t0 = Date.now();
    if (running) pause(t0); else resume(t0);
  };

  const skip = () => {
    if (pos.index >= steps.length - 1) { finish(); return; }
    seek(stepStartMs(steps, pos.index + 1));
  };

  const requestClose = () => {
    if (done) { onFinish(); return; }
    if (!running && clock.elapsed === 0) { onClose(); return; }
    // The routine holds still behind the question, so it can't finish (and log) there.
    resumeAfterConfirm.current = running;
    if (running) pause(Date.now());
    setConfirmLeave(true);
  };
  const keepGoing = () => {
    setConfirmLeave(false);
    if (resumeAfterConfirm.current) resume(Date.now());
  };
  useDismissable(true, requestClose);

  const prep = pos.phase === "prep";
  const fraction = pos.phaseMs > 0 ? pos.remainingMs / pos.phaseMs : 0;
  const secLeft = Math.max(0, Math.ceil(pos.remainingMs / 1000));
  const phaseLabel = prep
    ? t(isSideSwitch(steps, pos.index) ? "stretch.player.switchSides" : pos.index === 0 ? "stretch.player.getReady" : "stretch.player.nextUp")
    : t(MOVE_KIND[step.move] === "drill" ? "stretch.player.move" : "stretch.player.hold");
  const next = steps[pos.index + 1];

  return (
    <div className="fixed inset-0 bg-slate-900 z-[60] flex flex-col animate-slide-up">
      <header className="flex items-center gap-2 px-3 border-b border-slate-800 shrink-0"
        style={{ height: "calc(48px + var(--safe-top))", paddingTop: "var(--safe-top)" }}>
        <button onClick={requestClose} aria-label={t("stretch.player.close")} className="text-slate-400 hover:text-white p-1.5">
          <X size={20}/>
        </button>
        <div className="flex-1 min-w-0 text-center">
          <p className="text-sm font-semibold truncate">{routineName}</p>
          {!done && <p className="text-[11px] text-slate-400 tabular-nums">{t("stretch.player.progress", { n: pos.index + 1, total: steps.length })}</p>}
        </div>
        <button onClick={() => onVoiceChange(!voice)} aria-pressed={voice}
          aria-label={t("stretch.player.voice")}
          className={"p-1.5 rounded-full transition-colors " + (voice
            ? "text-teal-300 bg-teal-400/15 hover:bg-teal-400/25"
            : "text-slate-500 hover:text-slate-300")}>
          {voice ? <Volume2 size={20}/> : <VolumeX size={20}/>}
        </button>
      </header>

      {done ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <div className="w-16 h-16 rounded-full bg-teal-400/15 border border-teal-400/40 flex items-center justify-center text-teal-300">
            <Check size={30}/>
          </div>
          <p className="text-xl font-bold">{t("stretch.player.doneTitle", { name: routineName })}</p>
          <p className="text-sm text-slate-400">
            {playedSec >= MIN_LOGGED_SEC ? t("stretch.player.doneBody", { min: Math.max(1, Math.round(playedSec / 60)) }) : t("stretch.player.doneShort")}
          </p>
          <p className="text-xs text-slate-500">{weekCount > 0 ? t("stretch.sheet.week", { count: weekCount }) : t("stretch.sheet.weekNone")}</p>
          <div className="w-full max-w-sm mt-2"><StretchBetaNote compact onFeedback={onFeedback}/></div>
          <button onClick={onFinish} className="mt-3 px-6 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-sm font-semibold">
            {t("stretch.player.doneClose")}
          </button>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-lg mx-auto px-4 pt-3 space-y-3">
            <div className="flex gap-0.5" aria-hidden>
              {steps.map((_, i) => (
                <span key={i} className="flex-1 h-1 rounded-full bg-slate-700 overflow-hidden">
                  <span className="block h-full bg-teal-400"
                    style={{ width: i < pos.index ? "100%" : i > pos.index || prep ? "0%" : `${Math.round((1 - fraction) * 100)}%` }}/>
                </span>
              ))}
            </div>

            <div className="relative bg-slate-800 rounded-2xl flex items-center justify-center" style={{ height: "min(38vh, 300px)" }}>
              <StretchFigure move={step.move} side={step.side} animate={running} bg="#1e293b"
                className="h-full max-h-full aspect-square" label={name(step.move)}/>
              {step.side && (
                <span className="absolute top-2.5 right-2.5 text-[10.5px] font-bold uppercase tracking-wider text-teal-200 bg-teal-400/15 border border-teal-400/35 rounded-full px-2 py-0.5">
                  {t(step.side === "left" ? "stretch.player.left" : "stretch.player.right")}
                </span>
              )}
            </div>

            <div aria-live="polite">
              <p className="text-lg font-bold leading-tight">{name(step.move)}</p>
              <p className="text-xs text-slate-400">{t(`stretch.moves.${step.move}.target`)}</p>
            </div>

            <div className="flex items-center gap-4">
              <div className="relative w-28 h-28 shrink-0" role="timer" aria-live="off">
                <svg viewBox="0 0 104 104" className="w-full h-full -rotate-90" aria-hidden>
                  <circle cx="52" cy="52" r={RING_R} fill="none" stroke="#26324a" strokeWidth="7"/>
                  <circle cx="52" cy="52" r={RING_R} fill="none" strokeWidth="7" strokeLinecap="round"
                    stroke={prep ? "#fbbf24" : "#2dd4bf"} strokeDasharray={RING_C} strokeDashoffset={RING_C * (1 - fraction)}/>
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                  <span className="text-2xl font-extrabold tabular-nums leading-none">{Math.floor(secLeft / 60)}:{String(secLeft % 60).padStart(2, "0")}</span>
                  <span className={"text-[10.5px] mt-1 max-w-[76px] leading-tight " + (prep ? "text-amber-300" : "text-slate-400")}>{phaseLabel}</span>
                </div>
              </div>
              <ul className="space-y-1.5 min-w-0">
                {[1, 2, 3].map(n => (
                  <li key={n} className="flex gap-2 text-xs text-slate-300 leading-snug">
                    <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-teal-400 shrink-0" aria-hidden/>
                    {t(`stretch.moves.${step.move}.cue${n}`)}
                  </li>
                ))}
              </ul>
            </div>

            <p className="text-xs text-slate-400 bg-slate-800 rounded-xl px-3 py-2 line-clamp-2">
              {next
                ? (next.side
                  ? <Trans i18nKey="stretch.player.nextSide" values={{ name: name(next.move), side: sideWord(next.side) }} components={[<span className="text-slate-200 font-semibold"/>]}/>
                  : <Trans i18nKey="stretch.player.next" values={{ name: name(next.move) }} components={[<span className="text-slate-200 font-semibold"/>]}/>)
                : t("stretch.player.lastOne")}
            </p>
          </div>
        </div>
      )}

      {!done && (
        <div className="shrink-0 flex items-center justify-center gap-7 pt-3"
          style={{ paddingBottom: "calc(1.25rem + var(--safe-bottom))" }}>
          <button onClick={() => seek(backTarget(steps, pos))} aria-label={t("stretch.player.previous")}
            className="w-12 h-12 rounded-full bg-slate-800 hover:bg-slate-700 flex items-center justify-center text-slate-200">
            <SkipBack size={20}/>
          </button>
          <button onClick={togglePlay} aria-label={t(running ? "stretch.player.pause" : clock.elapsed > 0 ? "stretch.player.resume" : "stretch.player.play")}
            className="w-16 h-16 rounded-full bg-orange-500 hover:bg-orange-600 flex items-center justify-center text-white">
            {running ? <Pause size={26}/> : <Play size={26} className="ml-0.5"/>}
          </button>
          <button onClick={skip} aria-label={t("stretch.player.skip")}
            className="w-12 h-12 rounded-full bg-slate-800 hover:bg-slate-700 flex items-center justify-center text-slate-200">
            <SkipForward size={20}/>
          </button>
        </div>
      )}

      {confirmLeave && <LeaveConfirm onStop={onClose} onKeep={keepGoing}/>}
    </div>
  );
}
