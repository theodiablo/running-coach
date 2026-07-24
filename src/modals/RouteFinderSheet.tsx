import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, X, Loader, RefreshCw, MapPin, Sparkles, Star, Trash2, Check, Play } from "lucide-react";
import { RouteMap, type RouteGuide } from "../components/RouteMap";
import { useDismissable } from "../hooks/useDismissable";
import { routeSuggest, overlapWithHistory, historyNearCandidates, type ElevationPref } from "../utils/routeSuggest";
import { getRecentRoutePoints } from "../routes";
import { listSavedRoutes, saveRoute as persistSavedRoute, deleteSavedRoute, renameSavedRoute, type SavedRoute } from "../savedRoutes";
import { track } from "../telemetry";
import type { SuggestedRoute } from "../types";

type LatLng = { lat: number; lng: number };
type RouteFinderSheetProps = {
  location: LatLng | null;                 // current GPS fix from the tracker's idle preview
  onClose: () => void;
  onSelect: (route: SuggestedRoute) => void; // "Run this route" — hands the line to the tracker
  showToast?: (msg: string, type?: string) => void;
  initialKm?: number;                      // pre-set distance (e.g. opened from a plan session)
};

const DISTANCE_CHIPS = [5, 10, 21, 42]; // 5k, 10k, half, full — race-distance quick-picks
const DISTANCE_MIN = 2;   // km — slider bounds
const DISTANCE_MAX = 42;  // up to a marathon loop for long-run prep
const TERRAINS: ElevationPref[] = ["flat", "rolling", "hilly"];
// Clamp/round any km into the slider's whole-km range.
const clampKm = (km: number) => Math.min(DISTANCE_MAX, Math.max(DISTANCE_MIN, Math.round(km)));
// Selected candidate: solid sky, thick. Others: muted slate, thinner, semi-transparent.
const SELECTED_STYLE = { color: "#38bdf8", opacity: 1, weight: 6, dashed: false };
const OTHER_STYLE = { color: "#64748b", opacity: 0.6, weight: 4, dashed: false };

export function RouteFinderSheet({ location, onClose, onSelect, showToast, initialKm }: RouteFinderSheetProps) {
  const { t } = useTranslation();
  const [distance, setDistance] = useState(initialKm && initialKm > 0 ? String(clampKm(initialKm)) : "5");
  const [terrain, setTerrain] = useState<ElevationPref>("rolling");
  const [somewhereNew, setSomewhereNew] = useState(false);
  const [pickStart, setPickStart] = useState(false);
  const [customStart, setCustomStart] = useState<LatLng | null>(null);
  const [candidates, setCandidates] = useState<SuggestedRoute[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState<SavedRoute[]>([]);
  const seedBaseRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useDismissable(true, onClose);

  // Load the user's starred favourites once (best-effort; empty on failure).
  useEffect(() => { listSavedRoutes().then(rows => { if (mountedRef.current) setSaved(rows); }); }, []);

  const origin = customStart ?? location;
  const km = parseFloat(distance) || 0;
  // The slider works in whole km, clamped to its bounds (default 5).
  const sliderKm = Math.min(DISTANCE_MAX, Math.max(DISTANCE_MIN, Math.round(km) || 5));

  const generate = async (seedBase: number) => {
    if (!origin) { showToast?.(t("routeFinder.needLocation"), "err"); return; }
    if (!(km > 0)) return;
    setLoading(true);
    setCandidates(null);
    setSelectedId(null);
    track("route_suggested", {});
    const result = await routeSuggest({ lat: origin.lat, lng: origin.lng, km, elevation: terrain }, { seedBase });
    if (!mountedRef.current) return;
    if (result.status !== "ok") {
      setLoading(false);
      setCandidates([]);
      // Distinct message per outcome instead of one catch-all: capped vs no loop
      // here vs a real fetch failure each tell the user something different.
      const key = result.status === "rateLimited" ? "routeFinder.rateLimit"
        : result.status === "empty" ? "routeFinder.empty"
        : "routeFinder.none";
      showToast?.(t(key), "err");
      return;
    }
    let routes = result.routes;
    if (somewhereNew) {
      // "Somewhere new": penalise loops that retrace recorded routes. Coordinates
      // never leave the device — the recorded traces are fetched and compared here.
      const recent = await getRecentRoutePoints(20);
      if (!mountedRef.current) return;
      const allHistory = recent.flat().filter(Boolean) as [number, number, number | null][];
      // Bound the O(points × history) scan to recorded points near the candidates
      // (most of a heavy user's history is elsewhere in town), so the main thread
      // isn't blocked after the network wait.
      const history = historyNearCandidates(allHistory, routes);
      if (history.length) {
        routes = [...routes]
          .map(r => ({ r, novelty: overlapWithHistory(r.points, history) }))
          .sort((a, b) => a.novelty - b.novelty)
          .map(x => x.r);
      }
    }
    setLoading(false);
    setCandidates(routes);
    setSelectedId(routes[0].id);
  };

  const onGenerate = () => { seedBaseRef.current = 0; generate(0); };
  const onRegenerate = () => { seedBaseRef.current += 10; generate(seedBaseRef.current); };

  const selected = candidates?.find(c => c.id === selectedId) ?? null;

  const confirm = () => { if (selected) { onSelect(selected); onClose(); } };

  const onSave = async (route: SuggestedRoute) => {
    const row = await persistSavedRoute(route);
    if (!mountedRef.current) return;
    if (row) { setSaved(s => [row, ...s]); showToast?.(t("routeFinder.saved")); }
    else showToast?.(t("routeFinder.saveFailed"), "err");
  };

  const onDeleteSaved = async (id: string) => {
    const ok = await deleteSavedRoute(id);
    if (ok && mountedRef.current) setSaved(s => s.filter(r => r.id !== id));
  };

  // Editable saved-route title: responsive locally on each keystroke, persisted
  // on blur/Enter (the app's settings-field convention).
  const onEditSavedLabel = (id: string, label: string) =>
    setSaved(list => list.map(r => (r.id === id ? { ...r, label } : r)));
  const onCommitSavedLabel = (id: string, label: string) => { renameSavedRoute(id, label.trim()); };

  // Map guides: the candidate lines (selected highlighted), or a chosen favourite.
  // `id` makes each line tappable to select it; the selected one carries a
  // permanent tooltip with its distance + elevation.
  const guides: RouteGuide[] = (candidates ?? []).map(c => ({
    points: c.points,
    id: c.id,
    ...(c.id === selectedId ? SELECTED_STYLE : OTHER_STYLE),
    ...(c.id === selectedId
      ? { label: `${t("routeFinder.card.distance", { km: c.km.toFixed(1) })} · ${t("routeFinder.card.elevation", { m: c.elevation })}` }
      : {}),
  }));

  const onPick = (loc: LatLng) => {
    if (!pickStart) return;
    setCustomStart(loc);
    setPickStart(false);
  };

  return (
    <div className="fixed inset-0 bg-slate-900 z-[60] flex flex-col animate-slide-up">
      <header className="flex items-center justify-between px-4 border-b border-slate-800"
        style={{ height: "calc(44px + var(--safe-top))", paddingTop: "var(--safe-top)" }}>
        <div className="flex items-center gap-1.5">
          <Search size={15} className="text-orange-400" />
          <span className="text-sm font-semibold">{t("routeFinder.title")}</span>
        </div>
        <button onClick={onClose} aria-label={t("common.close")}
          className="text-slate-400 hover:text-white p-1.5"><X size={18} /></button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="relative h-[38vh] min-h-[220px]">
          <RouteMap points={[]} interactive location={origin} guides={guides} fitGuides={!!candidates?.length}
            onGuidePick={setSelectedId}
            onPick={pickStart ? onPick : undefined} className="h-full w-full" style={{}} />
          {pickStart && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[1000] bg-slate-900/85 text-slate-200 text-xs rounded-full px-3 py-1.5 border border-slate-700">
              {t("routeFinder.pickStartHint")}
            </div>
          )}
        </div>

        <div className="p-4 space-y-4">
          <p className="text-xs text-slate-400 -mb-1">{t("routeFinder.subtitle")}</p>
          {/* Distance: a slider (touch-friendly, no keyboard) with preset quick-picks */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-xs text-slate-400">{t("routeFinder.distance.label")}</p>
              <span className="text-base font-bold text-white tabular-nums">{t("routeFinder.distance.chip", { km: sliderKm })}</span>
            </div>
            <input type="range" min={DISTANCE_MIN} max={DISTANCE_MAX} step={1} value={sliderKm}
              onChange={e => setDistance(e.target.value)}
              className="w-full accent-orange-500" aria-label={t("routeFinder.distance.label")} />
            <div className="mt-2 flex flex-wrap gap-2">
              {DISTANCE_CHIPS.map(d => {
                const on = sliderKm === d;
                return (
                  <button key={d} onClick={() => setDistance(String(d))}
                    className={"px-3 py-1 rounded-full text-xs font-semibold border " + (on
                      ? "bg-orange-500 border-orange-500 text-white"
                      : "bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-500")}>
                    {t("routeFinder.distance.chip", { km: d })}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Terrain */}
          <div>
            <p className="text-xs text-slate-400 mb-1.5">{t("routeFinder.terrain.label")}</p>
            <div className="flex gap-2">
              {TERRAINS.map(tr => {
                const on = terrain === tr;
                return (
                  <button key={tr} onClick={() => setTerrain(tr)}
                    className={"flex-1 px-3 py-1.5 rounded-lg text-sm font-semibold border " + (on
                      ? "bg-slate-700 border-orange-400 text-white"
                      : "bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-500")}>
                    {t("routeFinder.terrain." + tr)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Options: somewhere new + pick start */}
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setSomewhereNew(v => !v)} aria-pressed={somewhereNew}
              className={"flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border " + (somewhereNew
                ? "bg-sky-500/20 border-sky-400 text-sky-200"
                : "bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-500")}>
              <Sparkles size={13} />{t("routeFinder.somewhereNew")}
            </button>
            <button onClick={() => setPickStart(v => !v)} aria-pressed={pickStart}
              className={"flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border " + (pickStart || customStart
                ? "bg-sky-500/20 border-sky-400 text-sky-200"
                : "bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-500")}>
              <MapPin size={13} />{t("routeFinder.pickStart")}
            </button>
            {customStart && (
              <button onClick={() => setCustomStart(null)}
                className="px-3 py-1.5 rounded-full text-xs font-semibold border bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500">
                {t("routeFinder.useMyLocation")}
              </button>
            )}
          </div>

          {/* Generate / regenerate */}
          <div className="flex gap-2">
            <button onClick={onGenerate} disabled={loading || !(km > 0)}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold bg-orange-500 hover:bg-orange-600 text-white disabled:opacity-50">
              {loading ? <Loader size={16} className="animate-spin" /> : <Search size={16} />}
              {loading ? t("routeFinder.searching") : t("routeFinder.generate")}
            </button>
            {!!candidates?.length && (
              <button onClick={onRegenerate} disabled={loading} aria-label={t("routeFinder.regenerate")}
                className="px-4 flex items-center justify-center rounded-xl bg-slate-800 border border-slate-700 text-slate-200 hover:border-slate-500 disabled:opacity-50">
                <RefreshCw size={16} />
              </button>
            )}
          </div>

          {/* Candidate cards */}
          {candidates && candidates.length > 0 && (
            <div className="space-y-2">
              {candidates.map((c, i) => {
                const on = c.id === selectedId;
                return (
                  <button key={c.id} onClick={() => setSelectedId(c.id)}
                    className={"w-full text-left rounded-xl border p-3 transition-colors " + (on
                      ? "bg-sky-500/10 border-sky-400"
                      : "bg-slate-800 border-slate-700 hover:border-slate-500")}>
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-white">
                        {t("routeFinder.card.candidate", { n: i + 1 })}
                      </span>
                      {on && <span className="flex items-center gap-1 text-[11px] text-sky-300"><Check size={13} />{t("routeFinder.selected")}</span>}
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-sm text-slate-300">
                      <span className="font-semibold text-white">{t("routeFinder.card.distance", { km: c.km.toFixed(1) })}</span>
                      <span className="text-slate-400">{t("routeFinder.card.elevation", { m: c.elevation })}</span>
                      {c.character && <span className="text-slate-400">{t("routeFinder.character." + c.character)}</span>}
                      <span className="ml-auto text-slate-500 hover:text-sky-300"
                        role="button" tabIndex={0} aria-label={t("routeFinder.save")}
                        onClick={e => { e.stopPropagation(); onSave(c); }}
                        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onSave(c); } }}>
                        <Star size={16} />
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Saved favourites */}
          {saved.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-slate-400">{t("routeFinder.favorites")}</p>
              {saved.map(s => (
                <div key={s.id} className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 py-2 pl-3 pr-2">
                  <div className="flex-1 min-w-0">
                    <input value={s.label ?? ""}
                      onChange={e => onEditSavedLabel(s.id, e.target.value)}
                      onBlur={e => onCommitSavedLabel(s.id, e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                      placeholder={t("routeFinder.namePlaceholder")} aria-label={t("routeFinder.namePlaceholder")}
                      className="w-full bg-transparent text-sm font-semibold text-white outline-none placeholder-slate-500" />
                    <span className="text-xs text-slate-400">
                      {t("routeFinder.card.distance", { km: s.km.toFixed(1) })} · {t("routeFinder.card.elevation", { m: s.elevation })}
                    </span>
                  </div>
                  <button onClick={() => { onSelect(s); onClose(); }} aria-label={t("routeFinder.confirm")}
                    className="p-1.5 text-sky-400 hover:text-sky-300"><Play size={16} /></button>
                  <button onClick={() => onDeleteSaved(s.id)} aria-label={t("routeFinder.removeSaved")}
                    className="p-1.5 text-slate-500 hover:text-red-400"><Trash2 size={16} /></button>
                </div>
              ))}
            </div>
          )}

          {/* Safety framing — always visible, factual, not dismissable */}
          <p className="text-[11px] leading-snug text-amber-200/90 bg-amber-400/10 border border-amber-400/20 rounded-xl px-3 py-2">
            {t("routeFinder.safety")}
          </p>
          <p className="text-[10px] text-slate-500 leading-snug">{t("routeFinder.attribution")}</p>
        </div>
      </div>

      {/* Confirm bar */}
      {selected && (
        <div className="p-4 border-t border-slate-800" style={{ paddingBottom: "calc(1rem + var(--safe-bottom))" }}>
          <button onClick={confirm}
            className="w-full py-3.5 rounded-2xl text-base font-semibold bg-orange-500 hover:bg-orange-600 text-white">
            {t("routeFinder.confirm")}
          </button>
        </div>
      )}
    </div>
  );
}
