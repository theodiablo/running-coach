import { useEffect, useState } from "react";

type Presence<T> = {
  /** The value to render — held for `exitMs` after `value` goes null. */
  rendered: T | null;
  /** True while the held value is animating out (drives the exit class). */
  closing: boolean;
};

// Keeps a value mounted briefly after it becomes null so an exit animation can play (the
// global toast). The live<->null transition uses the derived-state-during-render pattern,
// since react-hooks forbids sync setState in effects; the effect only runs the delayed clear,
// and its cleanup cancels the timer when `closing` flips back, so a fresh value isn't blanked.
export function usePresence<T>(value: T | null, exitMs: number): Presence<T> {
  const [rendered, setRendered] = useState<T | null>(value);
  const [closing, setClosing] = useState(false);
  const [prev, setPrev] = useState<T | null>(value);

  if (value !== prev) {
    setPrev(value);
    if (value !== null) {
      // Appearing or swapping to a new value: show it now and drop out of the
      // closing state (which re-runs the effect and clears any pending close).
      setRendered(value);
      setClosing(false);
    } else if (rendered !== null) {
      // Disappearing: keep the last value on screen and mark it closing.
      setClosing(true);
    }
  }

  useEffect(() => {
    if (!closing) return;
    const id = setTimeout(() => {
      setRendered(null);
      setClosing(false);
    }, exitMs);
    return () => clearTimeout(id);
  }, [closing, exitMs]);

  return { rendered, closing };
}
