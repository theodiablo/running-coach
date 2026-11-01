// Map a recharts mouse-event chart state to the active data index, or null. recharts v3
// reports `activeTooltipIndex` as a STRING for Line/Area/Composed charts, so a bare
// `typeof === "number"` check is always false and leaves the chart-to-map cursor null.
// Coerce and validate (index aligns 1:1 with the flattened track). Pure.
export function activeIndexFromChartState(
  s: { activeTooltipIndex?: number | string | null } | null | undefined,
): number | null {
  const raw = s == null ? null : s.activeTooltipIndex;
  if (raw == null || raw === "") return null;
  const i = Number(raw);
  return Number.isInteger(i) && i >= 0 ? i : null;
}
