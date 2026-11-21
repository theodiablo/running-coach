import { useTranslation } from "react-i18next";
import { DISTANCE_STOPS, LAST_STOP, dragThumb, isAnyDistance, rangeLabel, stopLabel } from "../../utils/raceFilters";
import type { DistanceRange } from "../../utils/raceFilters";

type Props = { value: DistanceRange; onChange: (r: DistanceRange) => void };

// Two handles over the distance scale: "10K to half" or "marathon and up" is one drag.
export function DistanceRangeSlider({ value, onChange }: Props) {
  const { t } = useTranslation();
  const pct = (i: number) => (i / LAST_STOP) * 100;
  const any = isAnyDistance(value);
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">{t("races.filters.distance")}</span>
        <span className="text-sm font-bold text-slate-100" aria-live="polite">{rangeLabel(t, value)}</span>
      </div>
      <div className="range-dual relative h-7 mx-1 mt-1">
        <div className="absolute inset-x-0 top-3 h-1 rounded-full bg-slate-700"/>
        <div className={"absolute top-3 h-1 rounded-full " + (any ? "bg-slate-500" : "bg-orange-500")}
          style={{ left: pct(value.min) + "%", right: (100 - pct(value.max)) + "%" }}/>
        <input type="range" min={0} max={LAST_STOP} step={1} value={value.min}
          aria-label={t("races.filters.shortest")} aria-valuetext={stopLabel(t, value.min)}
          onChange={e => onChange(dragThumb(value, "min", Number(e.target.value)))}/>
        <input type="range" min={0} max={LAST_STOP} step={1} value={value.max}
          aria-label={t("races.filters.longest")} aria-valuetext={stopLabel(t, value.max)}
          onChange={e => onChange(dragThumb(value, "max", Number(e.target.value)))}/>
      </div>
      <div className="flex justify-between text-[10px] tabular-nums mx-[15px]" aria-hidden="true">
        {DISTANCE_STOPS.map((_, i) => (
          <span key={i} className={"w-0 flex justify-center whitespace-nowrap " +
            (!any && i >= value.min && i <= value.max ? "text-orange-300 font-bold" : "text-slate-500")}>
            {stopLabel(t, i)}
          </span>
        ))}
      </div>
    </div>
  );
}
