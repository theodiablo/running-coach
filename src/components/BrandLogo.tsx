// The Running Coach brand mark ("Pulse Stride"): a pulse line rising into a finish
// dot. Single source for the app, marketing, Android adaptive icon and favicon.
// Defaults to `currentColor`, so callers colour it with a text class. Aspect ratio
// is 220:120 (~1.83:1); `size` sets the rendered height.

type BrandLogoProps = {
  size?: number;
  className?: string;
  color?: string;
  title?: string;
};

export function BrandLogo({ size = 24, className, color = "currentColor", title }: BrandLogoProps) {
  const width = (size * 220) / 120;
  return (
    <svg
      width={width}
      height={size}
      viewBox="0 0 220 120"
      fill="none"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <polyline
        points="10,80 60,80 78,44 96,96 114,60 132,80 160,80 200,28"
        stroke={color}
        strokeWidth="16"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="200" cy="28" r="12" fill={color} />
    </svg>
  );
}
