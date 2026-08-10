// The coach's visual mark: a heartbeat rising to a finish dot, echoing
// BrandLogo's vocabulary in lucide-compatible geometry (24×24, stroke 2, round
// caps) so it keeps the optical weight of the lucide icons it sits beside.
type CoachAvatarProps = {
  size?: number;
  // Wrap in the standard circular orange chip; className then overrides the
  // default "w-9 h-9" chip size. Bare, className goes on the svg.
  chip?: boolean;
  className?: string;
  title?: string;
};

export function CoachAvatar({ size = 18, chip, className, title }: CoachAvatarProps) {
  const svg = (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      className={chip ? undefined : className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}>
      {title ? <title>{title}</title> : null}
      <polyline points="3 14 7 14 9.5 8 12.5 17 14.5 12 17 12 21 7"/>
      <circle cx="21" cy="7" r="1.8" fill="currentColor" stroke="none"/>
    </svg>
  );
  if (!chip) return svg;
  return (
    <div className={"rounded-full bg-orange-500/15 text-orange-400 flex items-center justify-center flex-shrink-0 " + (className || "w-9 h-9")}>
      {svg}
    </div>
  );
}
