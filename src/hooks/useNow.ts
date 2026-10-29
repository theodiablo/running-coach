import { useEffect, useState } from "react";

const TICK_MS = 10000; // relabel "x ago" locally — no network, no DB read

// "Now", held in state and advanced on a slow tick, so freshness lines stay
// honest between pushes. Reading the clock during render would make the
// component impure and the label would drift with unrelated re-renders.
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}
