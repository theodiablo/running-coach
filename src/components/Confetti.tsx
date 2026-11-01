import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";

// CSS-only celebration burst: N particles falling via the `confetti-fall` keyframe (index.css),
// randomized by inline custom properties; transform/opacity only. The keyframe ends at opacity 0
// with `both` fill, so a left-mounted instance is invisible and inert. `onDone` fires once after
// the longest particle finishes; under reduced motion it renders nothing but still fires `onDone`.

const COLORS = ["#f97316", "#fbbf24", "#34d399", "#38bdf8", "#ffffff"];

type Particle = {
  left: number;
  color: string;
  dx: number;
  rot: number;
  dur: number;
  delay: number;
  size: number;
};

// Deterministic-enough spread without Math.random gymnastics: jitter each of the
// `count` evenly-spaced columns and vary the physics per index.
function makeParticles(count: number): Particle[] {
  return Array.from({ length: count }, (_, i) => {
    const r = Math.random();
    return {
      left: (i / count) * 100 + (r * 8 - 4),
      color: COLORS[i % COLORS.length],
      dx: (r - 0.5) * 160,
      rot: 360 + Math.round(r * 540),
      dur: 1.3 + r * 0.9,
      delay: r * 0.25,
      size: 6 + Math.round(r * 4),
    };
  });
}

export function Confetti({ count = 26, onDone }: { count?: number; onDone?: () => void }) {
  const reduced = usePrefersReducedMotion();
  const [particles] = useState(() => makeParticles(count));

  useEffect(() => {
    if (!onDone) return;
    const maxMs = reduced
      ? 0
      : Math.ceil(Math.max(...particles.map((p) => p.dur + p.delay)) * 1000);
    const t = setTimeout(onDone, maxMs);
    return () => clearTimeout(t);
  }, [onDone, reduced, particles]);

  if (reduced) return null;

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden z-[2200]">
      {particles.map((p, i) => (
        <span
          key={i}
          className="absolute top-0 rounded-sm animate-confetti"
          style={
            {
              left: p.left + "%",
              width: p.size,
              height: p.size * 1.4,
              background: p.color,
              "--cf-dx": p.dx + "px",
              "--cf-rot": p.rot + "deg",
              "--cf-dur": p.dur + "s",
              "--cf-delay": p.delay + "s",
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
