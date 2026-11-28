import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDismissable } from "../hooks/useDismissable";
import { MapPin, Check, Plus, AlertTriangle, Loader } from "lucide-react";
import { INPUT_CLS, LABEL_CLS } from "../constants";
import { track } from "../telemetry";
import { LocationPicker } from "../components/LocationPicker";
import { deleteRace, duplicateRefusal, findRaceDuplicates } from "../races";
import type { RaceDuplicate, RaceTerrain } from "../races";
import { useRaceDuplicates } from "../hooks/useRaceDuplicates";
import { rememberRaces } from "../utils/races";
import { climbLooksHigh, raceDateBounds, raceDateInBounds, raceUrl, tidyName } from "../utils/raceForm";
import { fmt, ymd } from "../utils/format";
import { notifyContribution } from "../notify";
import { countryCode, countryName } from "../utils/country";
import { guessCountry } from "../utils/guessCountry";
import { reverseGeocode } from "../utils/geocode";
import { CountryPicker } from "../components/CountryPicker";
import type { CatalogueRace, CatalogueEdition } from "../types";

type LatLng = { lat: number; lng: number };
type RaceForm = {
  name: string;
  city: string;
  cityFromMap: boolean;   // filled by the last pin, so the next pin may replace it
  country: string;
  url: string;
  date: string;
  distanceKm: string | number;
  elevation: string | number;
};
type RaceFormPrefill = { date?: string; distanceKm?: string | number; elevation?: string | number };
type RaceFormModalProps = {
  addRace: (race: { name?: string; city?: string | null; country?: string | null; lat?: number | null; lng?: number | null; distances?: number[]; url?: string | null; terrain?: RaceTerrain | null; distinctFrom?: string[] }) => Promise<CatalogueRace>;
  addEdition: (edition: { raceSlug: string; date: string; distanceKm: number; elevation: number }) => Promise<CatalogueEdition>;
  onContributed?: () => void | Promise<void>;
  showToast: (msg: string, type?: string) => void;
  onClose: () => void;
  prefill?: RaceFormPrefill;
  onCreated?: (editionId: string, existing?: boolean) => void;
  onUseExisting?: (race: CatalogueRace, editionId: string | null) => void;
};
type FieldErrors = { url?: string; date?: string; city?: string };
// `refused`: the database turned the save down; `distinctFrom`: races the runner already said it isn't.
type Dupe = { match: RaceDuplicate; refused: boolean; distinctFrom: string[] };

// "Add a race": contributes to the SHARED catalogue (instant, global); new entries are always unverified
// and tagged so. Duplicates are caught live and again on submit (docs/races.md, "Duplicates").
// `onCreated(editionId, existing)` hands the edition back instead of toast-and-close;
// `onUseExisting` opens an already-listed race the runner picked instead of adding theirs.
export function RaceFormModal({ addRace, addEdition, onContributed, showToast, onClose, prefill, onCreated, onUseExisting }: RaceFormModalProps) {
  const { t, i18n } = useTranslation();
  useDismissable(true, onClose);
  const [selected, setSelected] = useState<CatalogueRace | null>(null); // an existing race to add a date to
  const [f, setF] = useState<RaceForm>(() => ({ name: "", city: "", cityFromMap: false, country: guessCountry() ?? "", url: "",
    date: prefill?.date || "", distanceKm: prefill?.distanceKm ?? "", elevation: prefill?.elevation ?? "" }));
  const [loc, setLoc] = useState<LatLng | null>(null);   // { lat, lng } picked on the map
  const [terrain, setTerrain] = useState<RaceTerrain>("road");
  const [showPicker, setShowPicker] = useState(false);
  const [locating, setLocating] = useState(false);
  const reverseSeq = useRef(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [fieldErr, setFieldErr] = useState<FieldErrors>({});
  const [pinCountry, setPinCountry] = useState<string | null>(null);
  const [dupe, setDupe] = useState<Dupe | null>(null);
  const [today] = useState(() => ymd(new Date()));
  const set = (k: Exclude<keyof RaceForm, "cityFromMap">, v: string | number) => setF(prev => ({ ...prev, [k]: v }));

  // Live duplicate lookup on everything typed so far (skipped once a race is selected).
  const q = tidyName(f.name);
  const distNum = parseFloat(String(f.distanceKm));
  const dupQuery = { name: q, country: countryCode(f.country), lat: loc?.lat ?? null, lng: loc?.lng ?? null,
    date: f.date || null, distanceKm: distNum > 0 ? distNum : null };
  const liveOn = !selected && !dupe && (q.length >= 2 || !!(loc && dupQuery.date && dupQuery.distanceKm));
  const matches = useRaceDuplicates(dupQuery, liveOn).map(d => d.race);
  const urlPreview = f.url.trim() ? raceUrl(f.url) : null;
  const pinCountryOff = !!pinCountry && !!countryCode(f.country) && pinCountry !== countryCode(f.country);
  const climbHigh = climbLooksHigh(distNum, parseInt(String(f.elevation)) || 0, selected?.terrain || terrain);
  const dateBounds = raceDateBounds(today);

  // A pin fills the country, and the city unless the runner typed their own.
  const confirmLocation = (p: LatLng) => {
    setLoc(p);
    setPinCountry(null);
    setShowPicker(false);
    const seq = ++reverseSeq.current;
    setLocating(true);
    void reverseGeocode(p).then(place => {
      if (seq !== reverseSeq.current) return;
      setLocating(false);
      if (!place) return;
      setPinCountry(countryCode(place.country));
      setF(prev => {
        const fillCity = !!place.city && (!prev.city.trim() || prev.cityFromMap);
        return { ...prev, country: place.country ?? prev.country, ...(fillCity ? { city: place.city ?? "", cityFromMap: true } : {}) };
      });
    });
  };

  // `target`: an existing race to add the date to; null creates a new race. `distinctFrom`: the
  // listed races the runner said this isn't, so neither the lookup nor the repeat trigger asks again.
  const submit = async (target: CatalogueRace | null = selected, distinctFrom: string[] = []) => {
    if (locating) return;   // the pin's country is still on its way
    setErr("");
    const dist = parseFloat(String(f.distanceKm));
    if (!f.date || !dist) { setErr(t("races.form.errors.dateDistance")); return; }
    const name = tidyName(f.name);
    if (!target && name.length < 3) { setErr(t("races.form.errors.name")); return; }
    const country = countryCode(f.country);
    if (!target && !country) { setErr(t("races.form.errors.country")); return; }
    const city = tidyName(f.city);
    const errs: FieldErrors = {};
    if (!raceDateInBounds(f.date, today)) errs.date = t("races.form.errors.dateRange");
    if (!target && city.length === 1) errs.city = t("races.form.errors.city");
    if (!target && f.url.trim() && !raceUrl(f.url)) errs.url = t("races.form.errors.url");
    setFieldErr(errs);
    if (Object.keys(errs).length) return;
    const elevation = f.elevation ? parseInt(String(f.elevation)) : 0;
    const lookup = { name, country, lat: loc?.lat ?? null, lng: loc?.lng ?? null, date: f.date, distanceKm: dist };
    setBusy(true);
    if (!target && !distinctFrom.length) {
      try {
        const strong = (await findRaceDuplicates(lookup)).find(d => d.strong);
        if (strong) { setDupe({ match: strong, refused: false, distinctFrom }); setBusy(false); return; }
      } catch (e) {
        console.error("race duplicate check failed", e);   // never blocks: the database rule still stands
      }
    }
    // Track a race we create here so we can roll it back if the follow-up
    // addEdition fails — otherwise a childless race lingers in the catalogue.
    let createdRaceSlug: string | null = null;
    try {
      let raceSlug: string, created: CatalogueEdition;
      if (target) {
        raceSlug = target.slug || target.id;
        created = await addEdition({ raceSlug, date: f.date, distanceKm: dist, elevation });
        track("race_contributed", { kind: "edition" });
        notifyContribution({ type: "edition", editionId: created.id });
      } else {
        const race = await addRace({
          name, city: city || null, country,
          lat: loc?.lat ?? null, lng: loc?.lng ?? null, distances: [dist], url: raceUrl(f.url), terrain, distinctFrom,
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
      const refusal = duplicateRefusal(e);
      const match = refusal && (await findRaceDuplicates(lookup).catch(() => []))
        .find(d => d.race.slug === refusal.raceSlug);
      if (match) setDupe({ match: { ...match, editionId: match.editionId ?? refusal.editionId }, refused: true, distinctFrom });
      else setErr(t("races.form.errors.save"));
      setBusy(false);
    }
  };

  const pickExisting = (d: RaceDuplicate) => {
    rememberRaces([d.race]);
    if (onCreated && d.editionId) onCreated(d.editionId, true);
    else if (onUseExisting) onUseExisting(d.race, d.editionId);
    else showToast(t("races.form.dupe.usedToast"));
    onClose();
  };

  const addDateTo = (race: CatalogueRace) => {
    setSelected(race);
    setDupe(null);
    void submit(race);
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
          {dupe ? <DuplicatePrompt dupe={dupe} busy={busy} onUse={() => pickExisting(dupe.match)}
            onAddDate={() => addDateTo(dupe.match.race)}
            onDifferent={() => { setDupe(null); void submit(null, [...dupe.distinctFrom, dupe.match.race.slug || dupe.match.race.id]); }}
            onBack={() => setDupe(null)}/> : <>
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
              <div>
                <label className={LABEL_CLS}>{t("races.form.location")}</label>
                {!loc && <p className="text-[11px] text-slate-500 -mt-1 mb-1.5">{t("races.form.locationHint")}</p>}
                {loc ? (
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1.5 text-sm text-emerald-400"><MapPin size={14}/>{t("races.form.locationSet")}</span>
                    {locating && <Loader size={13} className="animate-spin text-slate-400" aria-label={t("races.form.locating")}/>}
                    <button onClick={() => setShowPicker(true)} className="text-xs text-orange-400 hover:text-orange-300 font-semibold">{t("races.form.change")}</button>
                  </div>
                ) : (
                  <button onClick={() => setShowPicker(true)}
                    className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-slate-200 px-3 py-2 rounded-xl text-sm font-semibold transition-colors">
                    <MapPin size={14}/>{t("races.form.setLocation")}
                  </button>
                )}
              </div>
              <div><label htmlFor="race-country" className={LABEL_CLS}>{t("races.form.country")}</label>
                <CountryPicker id="race-country" value={f.country} onChange={code => set("country", code)} locale={i18n.language}
                  placeholder={t("races.form.countryPlaceholder")} noMatch={t("races.form.countryNoMatch")}/>
                {pinCountryOff && pinCountry && (
                  <p className="flex items-center gap-2 text-[11px] text-amber-300 mt-1.5">
                    <span>{t("races.form.pinCountry", { country: countryName(pinCountry, i18n.language) || pinCountry })}</span>
                    <button onClick={() => set("country", pinCountry)} className="text-orange-400 hover:text-orange-300 font-semibold">
                      {t("races.form.usePinCountry", { country: countryName(pinCountry, i18n.language) || pinCountry })}
                    </button>
                  </p>
                )}</div>
              <div><label htmlFor="race-city" className={LABEL_CLS}>{t("races.form.city")}</label>
                <input id="race-city" value={f.city} onChange={e => { const city = e.target.value; setF(prev => ({ ...prev, city, cityFromMap: false })); }} placeholder={t("races.form.cityPlaceholder")} maxLength={80} className={INPUT_CLS}
                  aria-invalid={!!fieldErr.city} aria-describedby={fieldErr.city ? "race-city-err" : undefined}/>
                {fieldErr.city && <p id="race-city-err" className="text-xs text-red-400 mt-1">{fieldErr.city}</p>}</div>
              <div role="group" aria-label={t("races.filters.terrain")}>
                <span className={LABEL_CLS}>{t("races.filters.terrain")}</span>
                <div className="flex bg-slate-900 rounded-xl p-1 gap-1">
                  {(["road", "trail"] as const).map(v => (
                    <button key={v} aria-pressed={terrain === v} onClick={() => setTerrain(v)}
                      className={"flex-1 py-1.5 rounded-lg text-sm font-semibold transition-colors " + (terrain === v ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200")}>
                      {t("races.filters." + v)}
                    </button>
                  ))}
                </div>
              </div>
              <div><label htmlFor="race-url" className={LABEL_CLS}>{t("races.form.officialSite")}</label>
                <input id="race-url" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  value={f.url} onChange={e => { set("url", e.target.value); setFieldErr(prev => ({ ...prev, url: undefined })); }}
                  placeholder={t("races.form.officialSitePlaceholder")} maxLength={300} className={INPUT_CLS}
                  aria-invalid={!!fieldErr.url} aria-describedby={fieldErr.url ? "race-url-err" : urlPreview ? "race-url-preview" : undefined}/>
                {fieldErr.url
                  ? <p id="race-url-err" className="text-xs text-red-400 mt-1">{fieldErr.url}</p>
                  : urlPreview && <p id="race-url-preview" className="text-[11px] text-slate-500 mt-1 truncate">{t("races.form.urlPreview", { url: urlPreview.replace(/^https?:\/\//, "").replace(/\/$/, "") })}</p>}</div>
            </>
          )}

          <div><label htmlFor="race-date" className={LABEL_CLS}>{t("races.form.date")}</label>
            <input id="race-date" type="date" min={dateBounds.min} max={dateBounds.max} value={f.date}
              onChange={e => { set("date", e.target.value); setFieldErr(prev => ({ ...prev, date: undefined })); }} className={INPUT_CLS}
              aria-invalid={!!fieldErr.date} aria-describedby={fieldErr.date ? "race-date-err" : undefined}/>
            {fieldErr.date && <p id="race-date-err" className="text-xs text-red-400 mt-1">{fieldErr.date}</p>}</div>
          <div className="grid grid-cols-2 gap-3">
            <div><label htmlFor="race-distance" className={LABEL_CLS}>{t("races.form.distanceKm")}</label>
              <input id="race-distance" type="number" step="0.1" min="0" value={f.distanceKm} onChange={e => set("distanceKm", e.target.value)} placeholder={t("races.form.distanceKmPlaceholder")} className={INPUT_CLS}/></div>
            <div><label htmlFor="race-elevation" className={LABEL_CLS}>{t("races.form.elevation")}</label>
              <input id="race-elevation" type="number" min="0" value={f.elevation} onChange={e => set("elevation", e.target.value)} placeholder={t("races.form.elevationPlaceholder")} className={INPUT_CLS}/></div>
          </div>
          {climbHigh && <p className="text-[11px] text-amber-300 -mt-2">{t("races.form.climbHigh")}</p>}

          <div className="flex items-start gap-2 text-[11px] text-slate-400 bg-amber-500/5 border border-amber-500/20 rounded-xl p-2.5">
            <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5"/>
            <span>{t("races.form.disclaimer")}</span>
          </div>

          {err && <p className="text-sm text-red-400">{err}</p>}

          <div className="flex gap-2">
            <button onClick={() => void submit()} disabled={busy || locating}
              className="flex-1 flex items-center justify-center gap-1.5 bg-orange-500 hover:bg-orange-600 text-white py-3 rounded-xl font-semibold transition-colors disabled:opacity-60">
              {busy ? <Loader size={16} className="animate-spin"/> : <Plus size={16}/>}{t("races.form.submit")}
            </button>
            <button onClick={onClose} className="px-3 text-sm text-slate-400 hover:text-slate-200">{t("common.cancel")}</button>
          </div>
          </>}
        </div>
      </div>
    </div>

    {showPicker && (
      <LocationPicker
        initial={loc}
        geocodeQuery={[f.city.trim(), countryName(f.country, i18n.language) || ""].filter(Boolean).join(", ")}
        onConfirm={confirmLocation}
        onCancel={() => setShowPicker(false)}
      />
    )}
    </>
  );
}

// "Is this your race?": a strong match found before (or refused at) saving. Each "different race"
// answer adds that race to `distinctFrom`, so a second match can be answered too.
function DuplicatePrompt({ dupe, busy, onUse, onAddDate, onDifferent, onBack }: {
  dupe: Dupe; busy: boolean; onUse: () => void; onAddDate: () => void; onDifferent: () => void; onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { race, editionId } = dupe.match;
  const edition = race.editions.find(e => e.id === editionId);
  const place = [race.city, race.country && (countryName(race.country, i18n.language) || race.country)].filter(Boolean).join(", ");
  return (
    <div className="space-y-3">
      <p className="font-semibold">{t("races.form.dupe.title")}</p>
      <p className="text-sm text-slate-400">{t(dupe.refused ? "races.form.dupe.blockingBody" : "races.form.dupe.body")}</p>
      <div className="bg-slate-700/50 rounded-xl p-3">
        <p className="font-semibold">{race.name}</p>
        {place && <p className="text-xs text-slate-400">{place}</p>}
        {edition && <p className="text-xs text-slate-300 mt-1">{fmt.date(edition.date)} · {fmt.km(edition.distanceKm)} km</p>}
        {!race.verified && <p className="text-[11px] text-amber-400 mt-1">{t("races.unverifiedTag")}</p>}
      </div>
      <div className="space-y-2">
        {editionId
          ? <button onClick={onUse} disabled={busy} className="w-full bg-orange-500 hover:bg-orange-600 text-white py-3 rounded-xl font-semibold transition-colors disabled:opacity-60">{t("races.form.dupe.use")}</button>
          : <button onClick={onAddDate} disabled={busy} className="w-full flex items-center justify-center gap-1.5 bg-orange-500 hover:bg-orange-600 text-white py-3 rounded-xl font-semibold transition-colors disabled:opacity-60">
              {busy && <Loader size={16} className="animate-spin"/>}{t("races.form.dupe.addDate")}
            </button>}
        <button onClick={onDifferent} disabled={busy} className="w-full bg-slate-700 hover:bg-slate-600 text-slate-200 py-2.5 rounded-xl text-sm font-semibold transition-colors disabled:opacity-60">{t("races.form.dupe.different")}</button>
        <button onClick={onBack} disabled={busy} className="w-full text-sm text-slate-400 hover:text-slate-200 py-1">{t("races.form.dupe.back")}</button>
      </div>
    </div>
  );
}
