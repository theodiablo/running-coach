import { useEffect, useState } from "react";
import { POSES, cropViewBox, isMoving, poseAt } from "../stretch/poses";
import type { Chain, Pose, PoseDef, PoseId } from "../stretch/poses";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";

const NEAR = "#e2e8f0";   // slate-200
const FAR = "#64748b";    // slate-500
const TARGET = "#2dd4bf"; // teal-400
const STRAP = "#fb923c";  // orange-400
const GROUND = "#334155"; // slate-700
const WALL = "#2a3a52";

const r1 = (n: number) => Math.round(n * 10) / 10;
const d = (c: Chain) => "M" + c.map(([x, y]) => `${r1(x)} ${r1(y)}`).join(" L");
// A near limb's outline starts part-way down its first segment, so the joint stays attached.
const trimStart = (c: Chain): Chain => [[c[0][0] + (c[1][0] - c[0][0]) * 0.45, c[0][1] + (c[1][1] - c[0][1]) * 0.45], ...c.slice(1)];

function Body({ pose, bg }: { pose: Pose; bg: string }) {
  const line = { fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <>
      <path d="M8 181 L192 181" stroke={GROUND} strokeWidth={2.2} {...line}/>
      {pose.wallX !== undefined && <rect x={pose.wallX} y={14} width={9} height={167} rx={2} fill={WALL}/>}
      {pose.far.map((c, i) => <path key={"f" + i} d={d(c)} stroke={FAR} strokeWidth={10} {...line}/>)}
      <path d={d(pose.torso)} stroke={bg} strokeWidth={20} {...line}/>
      <path d={d(pose.torso)} stroke={NEAR} strokeWidth={15} {...line}/>
      <circle cx={r1(pose.head[0])} cy={r1(pose.head[1])} r={14} fill={bg}/>
      <circle cx={r1(pose.head[0])} cy={r1(pose.head[1])} r={11} fill={NEAR}/>
      {pose.near.map((c, i) => (
        <g key={"n" + i}>
          <path d={d(trimStart(c))} stroke={bg} strokeWidth={15} {...line}/>
          <path d={d(c)} stroke={NEAR} strokeWidth={10} {...line}/>
        </g>
      ))}
      {pose.target?.map((c, i) => <path key={"t" + i} d={d(c)} stroke={TARGET} strokeWidth={5} {...line}/>)}
      {pose.strap?.map((c, i) => <path key={"s" + i} d={d(c)} stroke={STRAP} strokeWidth={2.6} {...line}/>)}
    </>
  );
}

function useLoopClock(on: boolean): number {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (!on) return;
    let raf = 0, last = 0;
    const t0 = performance.now();
    const loop = (now: number) => {
      if (now - last > 33) { last = now; setMs(now - t0); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [on]);
  return ms;
}

type StretchFigureProps = {
  move: PoseId;
  /** The second side of a two-sided stretch, drawn facing the other way. */
  mirror?: boolean;
  /** Plays a drill's movement; holds and reduced motion stay still. */
  animate?: boolean;
  /** Zooms to the figure, for thumbnails. */
  crop?: boolean;
  /** The surface behind the figure, used to separate overlapping limbs. */
  bg?: string;
  className?: string;
  label?: string;
};

/** A stretch drawn from its pose data (src/stretch/poses.ts). */
export function StretchFigure({ move, mirror = false, animate = false, crop = false, bg = "#1e293b", className, label }: StretchFigureProps) {
  const def: PoseDef = POSES[move];
  const reduced = usePrefersReducedMotion();
  const moving = animate && !reduced && isMoving(def);
  const ms = useLoopClock(moving);
  const pose = moving ? poseAt(def, ms) : isMoving(def) ? def.frames[0] : def;
  return (
    <svg viewBox={crop ? cropViewBox(def) : "0 0 200 200"} className={className}
      role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <g transform={mirror ? "translate(200 0) scale(-1 1)" : undefined}>
        <Body pose={pose} bg={bg}/>
      </g>
    </svg>
  );
}
