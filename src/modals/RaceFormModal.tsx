import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useDismissable } from "../hooks/useDismissable";
import { MapPin, Check, Plus, AlertTriangle, Loader } from "lucide-react";
import { INPUT_CLS, LABEL_CLS } from "../constants";
import { track } from "../telemetry";
import { LocationPicker } from "../components/LocationPicker";
import { deleteRace } from "../races";
import { notifyContribution } from "../notify";
import type { CatalogueRace, CatalogueEdition } from "../types";

type LatLng = { lat: number; lng: number };
type RaceForm = {
  name: string;
  city: string;
  country: string;
  url: string;
  date: string;
  distanceKm: string | number;
  elevation: string | number;
};
type RaceFormPrefill = { date?: string; distanceKm?: string | number; elevation?: string | number };
type RaceFormModalProps = {
  catalogue: CatalogueRace[];
  addRace: (race: { name?: string; city?: string | null; country?: string | null; lat?: number | null; lng?: number | null; distances?: number[]; url?: string | null }) => Promise<CatalogueRace>;
  addEdition: (edition: { raceSlug: string; date: string; distanceKm: number; elevation: number }) => Promise<CatalogueEdition>;
  onContributed?: () => void | Promise<void>;
  showToast: (msg: string, type?: string) => void;
  onClose: () => void;
  prefill?: RaceFormPrefill;
  onCreated?: (editionId: string) => void;
};

// "Add a race" — contributes to the SHARED catalogue (instant + global). New
// entries are always unverified; the UI tags them so. Includes a live duplicate
// search so a user who's really just adding a new date gets steered to the
// existing race (→ add an edition) instead of creating a near-duplicate.
//
// Props: catalogue (grouped races, for dup search), addRace/addEdition (src/races
// via RunningCoach), onContributed (refresh the catalogue), showToast, onClose.
// Optional: prefill ({date, distanceKm, elevation}) seeds the form; onCreated
// (editionId) — when present, the caller wants the freshly-created edition back
// (e.g. onboarding promotes it to the training target) instead of the default
// toast-and-close.
export function RaceFormModal({ catalogue, addRace, addEdition, onContributed, showToast, onClose, prefill, onCreated }: RaceFormModalProps) {
  const { t } = useTranslation();
  useDismissable(true, onClose);
  const [selected, setSelected] = useState<CatalogueRace | null>(null); // an existing race to add a date to
  const [f, setF] = useState<RaceForm>({ name: "", city: "", country: "", url: "",
    date: prefill?.date || "", distanceKm: prefill?.distanceKm ?? "", elevation: prefill?.elevation ?? "" });
  const [loc, setLoc] = useState<LatLng | null>(null);   // { lat, lng } picked on the map
  const [showPicker, setShowPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: keyof RaceForm, v: string | number) => setF(prev => ({ ...prev, [k]: v }));

  // Live duplicate search on the name field (skipped once a race is selected).
  const matches = useMemo(() => {
    const q = f.name.trim().toLowerCase();
    if (selected || q.length < 2) return [];
    return (catalogue || [])
      .filter(r => (r.name + " " + (r.city || "") + " " + (r.country || "")).toLowerCase().includes(q))
      .slice(0, 5);
  }, [catalogue, f.name, selected]);

  const submit = async () => {
    setErr("");
    const dist = parseFloat(String(f.distanceKm));
    if (!f.date || !dist) { setErr(t("races.form.errors.dateDistance")); return; }
    if (!selected && !f.name.trim()) { setErr(t("races.form.errors.name")); return; }
    const elevation = f.elevation ? parseInt(String(f.elevation)) : 0;
    setBusy(true);
    // Track a race we create here so we can roll it back if the follow-up
    // addEdition fails — otherwise a childless race lingers in the catalogue.
    let createdRaceSlug: string | null = null;
    try {
      let raceSlug: string, name: string, created: CatalogueEdition;
      if (selected) {
        raceSlug = selected.slug || selected.id; name = selected.name;
        created = await addEdition({ raceSlug, date: f.date, distanceKm: dist, elevation });
        track("race_contributed", { kind: "edition" });
        notifyContribution({ type: "edition", editionId: created.id });
      } else {
        name = f.name.trim();
        const race = await addRace({
          name, city: f.city.trim() || null, country: f.country.trim().toUpperCase() || null,
          lat: loc?.lat ?? null, lng: loc?.lng ?? null, distances: [dist], url: f.url.trim() || null,
        });
        raceSlug = race.slug || race.id;
        createdRaceSlug = raceSlug;
        created = await addEdition({ raceSlug, date: f.date, distanceKm: dist, elevation });
        track("race_contributed", { kind: "race" });
        notifyContribution({ type: "race", raceSlug, editionId: created.id });
      }
      await onContributed?.();
      // Hand the new edition back when the caller wants it (onboarding promotes it
      // to the training target + shows its own confirmation); otherwise toast.
      if (onCreated) onCreated(created.id);
      else showToast(t("races.form.addedToast"));
      onClose();
    } catch (e) {
      console.error("add race failed", e);
      // Roll back a just-created race whose edition didn't land, so we don't
      // leave an orphan in the shared catalogue. Best-effort — already failing.
      if (createdRaceSlug) deleteRace(createdRaceSlug).catch(() => {});
      setErr(t("races.form.errors.save"));
      setBusy(false);
    }
  };

  return (
    <>
    <div className="fixed inset-0 bg-black/70 z-50 flex items-end justify-center p-4 animate-overlay-fade" onClick={onClose}
      style={{ paddingBottom: "calc(1rem + var(--safe-bottom))" }}>
      <div className="bg-slate-800 rounded-2xl w-full max-w-lg border border-slate-700 flex flex-col max-h-[90vh] overflow-hidden animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center px-4 py-3 border-b border-slate-700 shrink-0">
          <p className="font-semibold text-sm">{t("races.form.title")}</p>
          <button onClick={onClose} aria-label={t("common.close")} className="text-slate-400 hover:text-white text-lg leading-none px-1">x</button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto">
          {selected ? (
            <div className="flex items-center justify-between gap-2 bg-slate-700/50 rounded-xl p-3">
              <div className="min-w-0">
                <p className="text-xs text-slate-400">{t("races.form.addingDateTo")}</p>
                <p className="font-semibold truncate">{selected.name}</p>
              </div>
              <button onClick={() => setSelected(null)} className="text-xs text-orange-400 hover:text-orange-300 shrink-0">{t("races.form.change")}</button>
            </div>
          ) : (
            <>
              <div>
                <label className={LABEL_CLS}>{t("races.form.name")}</label>
                <input value={f.name} onChange={e => set("name", e.target.value)} placeholder={t("races.form.namePlaceholder")} maxLength={120} className={INPUT_CLS}/>
              </div>
              {matches.length > 0 && (
                <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-2 space-y-1">
                  <p className="text-[11px] text-slate-400 px-1">{t("races.form.alreadyListed")}</p>
                  {matches.map(r => (
                    <button key={r.slug} onClick={() => setSelected(r)}
                      className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-slate-700/60 text-sm flex items-center gap-2">
                      <Check size={13} className="text-emerald-400 shrink-0"/>
                      <span className="truncate">{r.name}<span className="text-slate-500"> · {[r.city, r.country].filter(Boolean).join(", ")}</span></span>
                    </button>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div><label className={LABEL_CLS}>{t("races.form.city")}</label>
                  <input value={f.city} onChange={e => set("city", e.target.value)} placeholder={t("races.form.cityPlaceholder")} maxLength={80} className={INPUT_CLS}/></div>
                <div><label className={LABEL_CLS}>{t("races.form.country")}</label>
                  <input value={f.country} onChange={e => set("country", e.target.value)} placeholder={t("races.form.countryPlaceholder")} maxLength={2} className={INPUT_CLS}/></div>
              </div>
              <div><label className={LABEL_CLS}>{t("races.form.officialSite")}</label>
                <input value={f.url} onChange={e => set("url", e.target.value)} placeholder={t("races.form.officialSitePlaceholder")} maxLength={300} className={INPUT_CLS}/></div>
              <div>
                <label className={LABEL_CLS}>{t("races.form.location")}</label>
                {loc ? (
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1.5 text-sm text-emerald-400"><MapPin size={14}/>{t("races.form.locationSet")}</span>
                    <button onClick={() => setShowPicker(true)} className="text-xs text-orange-400 hover:text-orange-300 font-semibold">{t("races.form.change")}</button>
                  </div>
                ) : (
                  <button onClick={() => setShowPicker(true)}
                    className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-slate-200 px-3 py-2 rounded-xl text-sm font-semibold transition-colors">
                    <MapPin size={14}/>{t("races.form.setLocation")}
                  </button>
                )}
              </div>
            </>
          )}

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-1"><label className={LABEL_CLS}>{t("races.form.date")}</label>
              <input type="date" value={f.date} onChange={e => set("date", e.target.value)} className={INPUT_CLS}/></div>
            <div><label className={LABEL_CLS}>{t("races.form.distanceKm")}</label>
              <input type="number" step="0.1" min="0" value={f.distanceKm} onChange={e => set("distanceKm", e.target.value)} placeholder={t("races.form.distanceKmPlaceholder")} className={INPUT_CLS}/></div>
            <div><label className={LABEL_CLS}>{t("races.form.elevation")}</label>
              <input type="number" min="0" value={f.elevation} onChange={e => set("elevation", e.target.value)} placeholder={t("races.form.elevationPlaceholder")} className={INPUT_CLS}/></div>
          </div>

          <div className="flex items-start gap-2 text-[11px] text-slate-400 bg-amber-500/5 border border-amber-500/20 rounded-xl p-2.5">
            <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5"/>
            <span>{t("races.form.disclaimer")}</span>
          </div>

          {err && <p className="text-sm text-red-400">{err}</p>}

          <div className="flex gap-2">
            <button onClick={submit} disabled={busy}
              className="flex-1 flex items-center justify-center gap-1.5 bg-orange-500 hover:bg-orange-600 text-white py-3 rounded-xl font-semibold transition-colors disabled:opacity-60">
              {busy ? <Loader size={16} className="animate-spin"/> : <Plus size={16}/>}{t("races.form.submit")}
            </button>
            <button onClick={onClose} className="px-3 text-sm text-slate-400 hover:text-slate-200">{t("common.cancel")}</button>
          </div>
        </div>
      </div>
    </div>

    {showPicker && (
      <LocationPicker
        initial={loc}
        geocodeQuery={[f.city.trim(), f.country.trim()].filter(Boolean).join(", ")}
        onConfirm={(p) => { setLoc(p); setShowPicker(false); }}
        onCancel={() => setShowPicker(false)}
      />
    )}
    </>
  );
}
