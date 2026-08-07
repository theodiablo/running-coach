import type { ReactNode } from "react";
import { DEFAULT_COACH_MARK } from "../utils/coachIdentity";

// The coach's visual identity: abstract sport marks the user picks from in
// Settings → Training profile. Lucide-compatible geometry (24×24, stroke 2,
// round caps) so a mark keeps the optical weight of the lucide icons it sits
// beside; the vocabulary (stroke polylines + a filled finish dot) echoes
// BrandLogo. An unknown/absent id falls back to the default mark — blob data
// must never crash or render blank.
const COACH_MARKS: Record<string, ReactNode> = {
  pulse: (
    <>
      <polyline points="3 14 7 14 9.5 8 12.5 17 14.5 12 17 12 21 7"/>
      <circle cx="21" cy="7" r="1.8" fill="currentColor" stroke="none"/>
    </>
  ),
  ridge: <polyline points="3 18 8.5 8 12 13.5 16 6 21 18"/>,
  track: (
    <>
      <rect x="3" y="7.5" width="18" height="9" rx="4.5"/>
      <rect x="7.5" y="10.5" width="9" height="3" rx="1.5"/>
    </>
  ),
  chevrons: (
    <>
      <polyline points="5 5 12 12 5 19"/>
      <polyline points="12 5 19 12 12 19"/>
    </>
  ),
  stopwatch: (
    <>
      <circle cx="12" cy="13.5" r="7"/>
      <line x1="12" y1="13.5" x2="15.5" y2="10"/>
      <line x1="9.5" y1="3" x2="14.5" y2="3"/>
    </>
  ),
  flag: (
    <>
      <line x1="6" y1="21" x2="6" y2="4"/>
      <path d="M6 4h12l-2.5 3.5L18 11H6"/>
    </>
  ),
};

type CoachAvatarProps = {
  id?: string;
  size?: number;
  // Wrap in the standard circular orange chip; className then overrides the
  // default "w-9 h-9" chip size. Bare, className goes on the svg.
  chip?: boolean;
  className?: string;
  title?: string;
};

export function CoachAvatar({ id, size = 18, chip, className, title }: CoachAvatarProps) {
  const svg = (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      className={chip ? undefined : className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}>
      {title ? <title>{title}</title> : null}
      {COACH_MARKS[id ?? DEFAULT_COACH_MARK] ?? COACH_MARKS[DEFAULT_COACH_MARK]}
    </svg>
  );
  if (!chip) return svg;
  return (
    <div className={"rounded-full bg-orange-500/15 text-orange-400 flex items-center justify-center flex-shrink-0 " + (className || "w-9 h-9")}>
      {svg}
    </div>
  );
}
