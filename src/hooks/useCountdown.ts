import { useCallback, useEffect, useRef, useState } from "react";

type Countdown = {
  /** Current number (3..1), 0 while the "Go!" frame shows, or null when idle. */
  count: number | null;
  /** Begin the countdown from `from` (default 3). */
  start: (from?: number) => void;
  /** Abort without firing `onDone`. */
  cancel: () => void;
};

// One-shot N..1..Go countdown firing `onDone` once; each step (the final "Go!" included)
// holds `stepMs`. A single timer cleared on unmount/cancel, so StrictMode double-mount or
// a mid-countdown close can't fire `onDone` twice.
export function useCountdown(onDone: () => void, stepMs = 1000): Countdown {
  const [count, setCount] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep the latest onDone without making it a dependency of the tick effect
  // (it's typically an inline closure, which would otherwise reset the timer
  // every render). Synced in an effect, never written during render.
  const doneRef = useRef(onDone);
  useEffect(() => { doneRef.current = onDone; });

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    clear();
    setCount(null);
  }, [clear]);

  const start = useCallback((from = 3) => {
    clear();
    setCount(from);
  }, [clear]);

  useEffect(() => {
    if (count === null) return;
    // The "Go!" frame lingers half a step before handing off, so it registers.
    const wait = count === 0 ? Math.round(stepMs / 2) : stepMs;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (count === 0) {
        setCount(null);
        doneRef.current();
      } else {
        setCount(count - 1);
      }
    }, wait);
    return clear;
  }, [count, stepMs, clear]);

  return { count, start, cancel };
}
