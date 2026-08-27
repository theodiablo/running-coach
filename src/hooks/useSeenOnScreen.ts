import { useEffect, useRef } from "react";

// Spends a one-time hint only once it has actually been on screen. A hint
// persisted at mount is spent by a visit that never scrolled down to it — and
// the surfaces these live on (the overdue card sits below the recovery banner,
// the live-run card, the stat tiles and the next-session card) are routinely
// off-screen on a phone.
//
// Attach the returned ref to the hint itself. `onSeen` fires at most once per
// mount, and the caller's persisted flag makes the next mount a no-op.
export function useSeenOnScreen<T extends HTMLElement>(active: boolean, onSeen: () => void) {
  const ref = useRef<T | null>(null);
  const spent = useRef(false);
  const latest = useRef(onSeen);
  useEffect(() => { latest.current = onSeen; });
  useEffect(() => {
    const el = ref.current;
    if (!active || spent.current || !el) return;
    const spend = () => {
      if (spent.current) return;
      spent.current = true;
      latest.current();
    };
    // Every engine we ship to has IntersectionObserver (both WebViews included);
    // the fallback is for jsdom.
    if (typeof IntersectionObserver === "undefined") { spend(); return; }
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { spend(); io.disconnect(); }
    }, {threshold: 0.6});
    io.observe(el);
    return () => io.disconnect();
  }, [active]);
  return ref;
}
