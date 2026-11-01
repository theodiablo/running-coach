import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

// Whether the OS "reduce motion" setting is on. Styling degrades via the media query
// in index.css; this hook is only for places that change *behaviour* (skip the
// countdown, no confetti). jsdom has no matchMedia, so the read is guarded (false).
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window.matchMedia !== "function") return false;
    return window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(QUERY);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
