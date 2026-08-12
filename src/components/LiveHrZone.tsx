import { useTranslation } from "react-i18next";
import { HR_ZONES, hrZoneBpm, runZoneIndex } from "../utils/hr";

type LiveHrZoneProps = { bpm: number | null | undefined; effMax: number; restHR: number };

// The live "which zone am I in" readout for a session in progress: the zone
// name over the five-colour strip with the current reading marked. Same zone
// definitions, Karvonen maths and zone names as the settings editor and the
// Progress card (utils/hr.ts, progress.zones.* copy) — this is the live view of
// them, not a second model.
//
// Returns null when the profile can't classify (no max HR, or a non-positive
// heart-rate reserve), mirroring HRZonesCard — a bar with no meaning is worse
// than no bar.
export function LiveHrZone({ bpm, effMax, restHR }: LiveHrZoneProps) {
  const { t } = useTranslation();
  if (!effMax || effMax - restHR <= 0) return null;
  const zone = runZoneIndex(bpm, effMax, restHR);
  const z = zone ? HR_ZONES[zone - 1] : null;
  // The strip is the five ZONES, which start at Z1's floor (50% of heart-rate
  // reserve), not at resting HR — so the marker maps across [Z1 floor, max],
  // not [rest, max]. Getting that wrong put the marker in the wrong block for
  // every reading. The zones are equal 10%-of-reserve bands, so this is linear
  // and lands exactly in the block `zone` names. Clamped, so an out-of-range
  // reading parks at an end of the bar instead of escaping it.
  const floor = hrZoneBpm(HR_ZONES[0].lo, HR_ZONES[0].hi, effMax, restHR)!.lo;
  const pct = bpm ? Math.min(100, Math.max(0, ((bpm - floor) / (effMax - floor)) * 100)) : null;
  return (
    <div className="space-y-1.5">
      <p className="text-center text-sm font-semibold" style={z ? { color: z.clr } : undefined}>
        {z
          ? t("progress.zones.zoneLabel", { n: z.n, name: t("progress.zones.names." + z.n) })
          : <span className="text-slate-500">{t("tracker.indoor.zoneUnknown")}</span>}
      </p>
      <div className="relative">
        <div className="flex rounded-lg overflow-hidden h-3">
          {HR_ZONES.map(zn => (
            <div key={zn.n} className="flex-1 transition-opacity"
              style={{ background: zn.clr, opacity: zone === zn.n ? 1 : 0.3 }} />
          ))}
        </div>
        {pct != null && (
          <span aria-hidden style={{ left: pct + "%" }}
            className="absolute -top-1 h-5 w-1 -translate-x-1/2 rounded-full bg-white shadow" />
        )}
      </div>
      {/* The bar's real ends, so the marker's position can be read off them. */}
      <div className="flex justify-between text-[10px] text-slate-500 px-0.5">
        <span>{t("tracker.indoor.zoneFloorBpm", { bpm: floor })}</span>
        <span>{t("tracker.indoor.maxBpm", { bpm: effMax })}</span>
      </div>
    </div>
  );
}
