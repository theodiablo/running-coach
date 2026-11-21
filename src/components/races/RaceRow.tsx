import { useTranslation } from "react-i18next";
import { AlertTriangle, CalendarX, Check, Mountain, Target } from "lucide-react";
import { currentLocaleTag } from "../../i18n";
import { fmtKm } from "../../hooks/useNearMeFilter";
import { countryName } from "../../utils/country";
import { ymd } from "../../utils/format";
import type { CatalogueEdition, CatalogueRace } from "../../types";

type Props = {
  race: CatalogueRace;
  // The editions that answer the filters, soonest first; the first one is what the row leads with.
  editions: CatalogueEdition[];
  highlightKm: (km: number) => boolean;
  onList: boolean;
  isTarget: boolean;
  onOpen: () => void;
};

// One catalogue race in Find: a calendar tile for its next date, place, distances, and its state.
export function RaceRow({ race, editions, highlightKm, onList, isTarget, onOpen }: Props) {
  const { t, i18n } = useTranslation();
  const lead = editions[0];
  const d = lead ? new Date(lead.date + "T12:00:00") : null;
  const kms = [...new Set((race.editions || []).map(e => e.distanceKm))].sort((a, b) => a - b);
  const more = editions.filter(e => e.date !== lead?.date).length;
  const today = ymd(new Date());
  // Every edition behind us and none announced: the row must not read like an upcoming race.
  const noUpcoming = !(race.editions || editions).some(e => e.date >= today);
  return (
    <button onClick={onOpen}
      className={"w-full flex items-center gap-3 text-left border rounded-2xl px-3 py-2.5 transition-colors " + (noUpcoming
        ? "bg-slate-800/50 border-slate-700/60 hover:border-slate-500 opacity-80" : "bg-slate-800 border-slate-700 hover:border-slate-500")}>
      <div className="w-11 shrink-0 rounded-xl bg-slate-900 py-1 text-center">
        {d ? (
          <>
            <p className={"text-[10px] font-bold uppercase tracking-wide " + (noUpcoming ? "text-slate-500" : "text-orange-400")}>{d.toLocaleDateString(currentLocaleTag(), { month: "short" })}</p>
            <p className={"text-lg font-extrabold leading-tight tabular-nums" + (noUpcoming ? " text-slate-400" : "")}>{d.getDate()}</p>
          </>
        ) : <p className="text-[10px] text-slate-500 py-2">–</p>}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold leading-snug line-clamp-2">{race.name}</p>
        <p className="text-xs text-slate-400 truncate">
          {[race.city, race.country ? countryName(String(race.country), i18n.language) || race.country : null].filter(Boolean).join(", ")}
          {lead && lead.date.slice(0, 4) !== String(new Date().getFullYear()) ? " · " + lead.date.slice(0, 4) : ""}
          {more > 0 ? " · " + t("races.row.moreDates", { count: more }) : ""}
        </p>
        <div className="flex flex-wrap items-center gap-1 mt-1.5">
          {kms.map(km => (
            <span key={km} className={"text-[10.5px] font-bold px-1.5 py-px rounded-md " +
              (highlightKm(km) ? "bg-orange-500/20 text-orange-300" : "bg-slate-700/70 text-slate-200")}>{km} km</span>
          ))}
          {race.terrain === "trail" && (
            <span className="inline-flex items-center gap-0.5 text-[10.5px] font-bold px-1.5 py-px rounded-md bg-emerald-500/10 text-emerald-300">
              <Mountain size={10}/>{t("races.filters.trail")}
            </span>
          )}
          {noUpcoming && (
            <span className="inline-flex items-center gap-0.5 text-[10.5px] font-bold px-1.5 py-px rounded-md bg-slate-700/50 text-slate-400">
              <CalendarX size={10}/>{t("races.row.noUpcoming")}
            </span>
          )}
          {isTarget ? (
            <span className="inline-flex items-center gap-0.5 text-[10.5px] font-bold text-orange-300"><Target size={10}/>{t("races.upcoming.trainingTarget")}</span>
          ) : onList && (
            <span className="inline-flex items-center gap-0.5 text-[10.5px] font-bold text-emerald-400"><Check size={10}/>{t("races.card.onYourList")}</span>
          )}
          {!race.verified && (
            <span title={t("races.card.unverifiedTitle")} className="inline-flex items-center gap-0.5 text-[10.5px] font-bold text-amber-300">
              <AlertTriangle size={10}/>{t("races.row.unverified")}
            </span>
          )}
        </div>
      </div>
      {race.distKm != null && (
        <span className="shrink-0 text-[11px] text-slate-400 text-right tabular-nums">{fmtKm(race.distKm * 1000)}</span>
      )}
    </button>
  );
}
