import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, ChevronLeft, ShieldAlert, AlertTriangle, Search, Check, Target, Sparkles, MapPin, Trophy, Navigation, Loader, Bluetooth } from "lucide-react";
import { INPUT_CLS, DISCLAIMER_VERSION, DISCLAIMER_URL } from "../constants";
import { LANGS, setLocale, currentLang, isLangId, type LangId } from "../i18n";
import { AvailabilityEditor } from "../components/AvailabilityEditor";
import { GoalConfigurator } from "../components/GoalConfigurator";
import { StylePicker } from "../components/StylePicker";
import { Chip } from "../components/RaceFilterChips";
import { BANDS, RADII, useNearMeFilter, fmtKm } from "../hooks/useNearMeFilter";
import { haversineM } from "../utils/geo";
import {
  trainingLevels, isStyleId, isTrainingLevel, recommendStyle, suggestPlanSessions,
  type StyleId, type TrainingLevel,
} from "../utils/planStyles";
import {
  sessionsFromSimple, suggestSimpleAvailability, clampDays, isBand,
  type AvailabilityMode, type DurationBand,
} from "../utils/availability";
import { RaceFormModal } from "./RaceFormModal";
import { AddRaceCard } from "../components/AddRaceCard";
import { Confetti } from "../components/Confetti";
import { CoachAvatar } from "../components/CoachAvatar";
import { onboardingSteps } from "../utils/onboarding";
import { isNative } from "../native";
import { useBlePairing, type BleDevice } from "../hooks/useBlePairing";
import { BleScanList } from "../components/BleScanList";
import { searchEditions, editionLabel, findEdition } from "../utils/races";
import { suggestedGoalSec } from "../utils/goal";
import { deriveAge, runnerAge, tanakaMaxHR } from "../utils/hr";
import { buildPlan } from "../utils/plan";
import type { PlanSessionInput } from "../utils/plan";
import { addWeeks, ymd, fmt } from "../utils/format";
import type { CatalogueEdition, CatalogueRace, HealthAck, HrMethod, Intent, JoinedEdition, SettingsState } from "../types";


type OnboardingStepKey = "welcome" | "intent" | "race" | "raceGoal" | "training" | "hr" | "health" | "summary";
type OnboardingProgress = Partial<SettingsState>;
type OnboardingCompletePayload = {
  name: string;
  plan: {
    raceDate: string;
    goalSec: string | number;
    distanceKm: string | number;
    raceElevation: number;
    planSessions: PlanSessionInput[];
    targetEditionId: string | null;
    planStyle: StyleId;
    trainingLevel: TrainingLevel | null;
    availabilityMode: AvailabilityMode;
    availDays: number;
    availTime: DurationBand;
  };
  hr: Pick<SettingsState, "birthYear" | "age" | "maxHR" | "restHR"> | null;
  // Set only when a strap was paired here — pairing IS choosing it as the HR
  // source, the same rule the Connections card follows.
  hrMethod: HrMethod | null;
  healthAck: NonNullable<HealthAck>;
};
type OnboardingWizardProps = {
  settings: SettingsState;
  onSaveProgress: (partial: OnboardingProgress, step: number) => void;
  onComplete: (payload: OnboardingCompletePayload) => void;
  catalogue: CatalogueRace[];
  addRace: (race: { name?: string; city?: string | null; country?: string | null; lat?: number | null; lng?: number | null; distances?: number[]; url?: string | null }) => Promise<CatalogueRace>;
  addEdition: (edition: { raceSlug: string; date: string; distanceKm: number; elevation: number }) => Promise<CatalogueEdition>;
  refreshCatalogue: () => void | Promise<void>;
  showToast: (msg: string, type?: string) => void;
};

// Guided first-run onboarding. The flow branches on the user's intent:
//   Welcome → Intent ─┬─ (race)   → Pick race → Goal & days ─┐
//                     └─ (fitness)→ Your training ───────────┤
//                                          → Heart rate → Health & safety → Summary
// The branch sequence is the pure `onboardingSteps(intent)`. The health & safety
// step is the mandatory gate and the only way into the app (header "Skip" jumps
// TO it, never around it); `summary` is an in-memory-only celebration after the
// gate. All input is held in local draft state and only committed via onComplete.
export function OnboardingWizard({settings, onSaveProgress, onComplete, catalogue, addRace, addEdition, refreshCatalogue, showToast}: OnboardingWizardProps) {
  const { t } = useTranslation();
  // Language: synced preference falling back to the live UI language; a tap
  // switches immediately and persists rc_lang (per-device) so a resumed
  // onboarding and the pre-login screens match. Included in the next progress
  // save so the choice survives a mid-flow refresh.
  const uiLang: LangId = isLangId(settings.language) ? settings.language : currentLang();
  const pickLang = (id: LangId) => { void setLocale(id); onSaveProgress({ language: id }, Math.min(stepIdx, seq.indexOf("health"))); };
  const today = ymd(new Date());

  const [intent, setIntent] = useState<Intent>(settings.intent || null); // null | "race" | "fitness"
  const seq = onboardingSteps(intent);

  const [stepIdx, setStepIdx] = useState(() =>
    Math.min(Math.max(0, settings.onboardStep || 0), seq.length - 1));
  const cur = seq[stepIdx] || "welcome";

  // Shared draft — both branches funnel into the same race-shaped fields so the
  // summary and completion read them uniformly (the fitness branch synthesizes a
  // target date + distance + goal when leaving the training step).
  const [name,          setName] = useState(settings.name || "");
  const [raceDate,      setRaceDate] = useState(settings.raceDate || "");
  const [distanceKm,    setDist] = useState<string | number>(settings.distanceKm || "");
  const [raceElevation, setElev] = useState<string | number>(settings.raceElevation || 0);
  const [goalSec,       setGoal] = useState<string | number>(settings.goalSec || "");
  // Availability. Simple mode (day count + duration band, coach places the days)
  // is the beginner default; Custom is the exact days/durations editor. Both feed
  // the same weekly-load meter and resolve to concrete planSessions on save.
  // The day/band drafts start null and track a distance/level-aware suggestion
  // until the user touches them; the custom sessions draft mirrors the old
  // "untouched = live suggestion" behaviour.
  const DEFAULT_SESS = JSON.stringify([{dayOffset:2,minutes:30},{dayOffset:6,minutes:60}]);
  const hasCustomSess = !!settings.planSessions?.length && JSON.stringify(settings.planSessions) !== DEFAULT_SESS;
  // No availabilityMode saved but customized sessions present = progress written
  // by a pre-availability-modes build; resuming in Simple would silently replace
  // those configured days with sessionsFromSimple output on Continue.
  const [availMode, setAvailMode] = useState<AvailabilityMode>(
    settings.availabilityMode === "custom" || (!settings.availabilityMode && hasCustomSess) ? "custom" : "simple");
  const [availDaysDraft, setAvailDays] = useState<number | null>(typeof settings.availDays === "number" ? settings.availDays : null);
  const [availBandDraft, setAvailBand] = useState<DurationBand | null>(isBand(settings.availTime) ? settings.availTime : null);
  const [sessDraft, setSess] = useState<PlanSessionInput[] | null>(hasCustomSess ? settings.planSessions ?? null : null);
  // Methodology style: null = untouched, so the pre-selection tracks the live
  // recommendation while the user edits days/distance; a tap pins the choice.
  const [planStyle,     setPlanStyle] = useState<StyleId | null>(isStyleId(settings.planStyle) ? settings.planStyle : null);
  // Self-reported current running volume — the one-question fitness signal
  // that stands in for run history (there is none on a first run).
  const [level, setLevel] = useState<TrainingLevel | null>(
    isTrainingLevel(settings.trainingLevel) ? settings.trainingLevel : null);
  const [targetEditionId, setTargetEditionId] = useState<string | null | undefined>(settings.targetEditionId);
  const [pickedLabel,   setPickedLabel] = useState(() => {
    const e = findEdition(settings.targetEditionId);
    return e ? editionLabel({ name: String(e.name) }, e.edition) : "";
  });

  // Race-picker UI state — same filters as the Races tab's Find panel (text
  // search + event distance band always apply; Near me layers on a one-off
  // geolocation sort/radius), so the two pickers never drift.
  const [query,   setQuery]   = useState("");
  const [manual,  setManual]  = useState(false);
  const [showAddRace, setShowAddRace] = useState(false);
  const [band, setBand] = useState<number | null>(null);
  const { nearMe, radius, setRadius, loc, status: locStatus, toggleNearMe } = useNearMeFilter("onboarding_find_near_me");

  // No-race ("get fit") branch picks. `selKey` tracks the chosen tile (so "5K"
  // and "Just run more" both map to 5 km but stay visually distinct).
  const [fitDist, setFitDist] = useState(5);
  const [selKey,  setSelKey]  = useState("5");
  const [horizon, setHorizon] = useState(12);

  // Heart rate (optional). Birth year, not age, so it never goes stale; a
  // legacy-age resume seeds a derived year (±1 yr is fine for Tanaka).
  const thisYear = new Date().getFullYear();
  const legacyAge = runnerAge(settings);
  const [birthYear, setBirthYear] = useState(
    String(settings.birthYear || (legacyAge != null ? thisYear - legacyAge : "") || ""));
  const [maxHR,  setMaxHR]  = useState(String(settings.maxHR || ""));
  const [restHR, setRestHR] = useState(String(settings.restHR || 60));
  const [maxHRHint, setMaxHRHint] = useState("");
  // A runner who already owns a strap should never have to discover pairing on
  // their own later: the heart-rate step is the one moment we have their
  // attention on the subject, so it offers the same disclosure-gated pairing
  // the Connections card does. Native only — a browser can't reach a sensor.
  const [sensor, setSensor] = useState<BleDevice | null>(null);
  const [sensorOpen, setSensorOpen] = useState(false);
  const sensorPairing = useBlePairing({
    showToast,
    onPaired: d => { setSensor(d); setSensorOpen(false); },
  });

  // Final step — health & safety screening + disclaimer. The screening answer is
  // GDPR special-category health data, so it lives ONLY in local state and is
  // never persisted; we persist only the acknowledgment record (timestamp +
  // disclaimer version) at completion via onComplete.
  const [screenApplies, setScreenApplies] = useState<boolean | null>(null); // null | false | true
  const [ackChecked, setAckChecked] = useState(false);
  const [medConfirm, setMedConfirm] = useState(false);
  const flagged  = screenApplies === true;
  const answered = screenApplies !== null;
  const canPassHealth = answered && ackChecked && (!flagged || medConfirm);

  const effectiveDist = intent === "fitness" ? fitDist : distanceKm;
  // Simple-mode day/band, tracking a suggestion until the user pins one.
  const availSuggestion = suggestSimpleAvailability(effectiveDist || 10, level);
  const availDays = availDaysDraft ?? availSuggestion.days;
  const availBand = availBandDraft ?? availSuggestion.band;
  // Custom-mode sessions, tracking the day/duration suggestion until edited.
  const customSessions = sessDraft ?? suggestPlanSessions(effectiveDist || 10, level);
  const planSessions = availMode === "custom" ? customSessions : sessionsFromSimple(availDays, availBand);
  const availMeta = availMode === "custom"
    ? { availabilityMode: "custom" as const, availDays: customSessions.length, availTime: availBand }
    : { availabilityMode: "simple" as const, availDays, availTime: availBand };

  // Age from the HR draft when entered, else settings (resumed onboarding);
  // usually null on a first run since the HR step comes after the style picker.
  const recommendedStyle = recommendStyle({
    intent, planSessions,
    distanceKm: effectiveDist,
    recentRuns: [],
    level,
    age: deriveAge(parseInt(birthYear) || 0) ?? runnerAge(settings),
  });
  const effectiveStyle = planStyle ?? recommendedStyle;

  const trimmedName = name.trim();
  const byN = parseInt(birthYear) || 0;
  const ageN = deriveAge(byN);
  const tanakaMax = ageN != null ? tanakaMaxHR(ageN) : null;

  // Navigate to a step by key. Persisted `onboardStep` is capped at the health
  // gate so `summary` is never persisted — a refresh on it resumes at the gate
  // and the acknowledgment is always captured fresh. `intent` is persisted too
  // so a mid-flow refresh rebuilds the right branch.
  const go = (key: OnboardingStepKey, partial: OnboardingProgress = {}, nextIntent: Intent = intent) => {
    const ns = onboardingSteps(nextIntent);
    const idx = ns.indexOf(key);
    if (idx < 0) return;
    if (nextIntent !== intent) setIntent(nextIntent);
    setStepIdx(idx);
    onSaveProgress({...partial, intent: nextIntent}, Math.min(idx, ns.indexOf("health")));
  };
  const back = () => { if (stepIdx > 0) go(seq[stepIdx - 1]); };
  const skip = () => go("health");

  const estimateHR = () => {
    if (!tanakaMax) { setMaxHRHint(t("onboarding.hr.enterBirthYear")); return; }
    setMaxHR(String(tanakaMax));
    setRestHR("60");
    setMaxHRHint(t("onboarding.hr.estimated", { max: tanakaMax }));
  };

  // Pick a catalogue edition → autofill the race fields + set it as the training
  // target (mirrors RunningCoach's promoteEdition, but onboarding builds the plan
  // straight away so we set targetEditionId here).
  const pick = (e: JoinedEdition) => {
    setRaceDate(e.edition.date);
    setDist(e.edition.distanceKm);
    setElev(e.edition.elevation || 0);
    setTargetEditionId(e.edition.id);
    setPickedLabel(editionLabel({ name: String(e.name) }, e.edition));
  };
  const clearPick = () => {
    setPickedLabel(""); setTargetEditionId(undefined);
    setRaceDate(""); setDist(""); setElev(0);
  };
  // Manual edits decouple from the catalogue (no targetEditionId → no auto-detect
  // against a now-irrelevant edition).
  const onManualEdit = () => { if (targetEditionId) { setTargetEditionId(undefined); setPickedLabel(""); } };

  // A race contributed to the catalogue from here becomes the training target:
  // feed it back into the same pick() path. The catalogue is already refreshed by
  // the modal, so findEdition resolves; if it lags, keep the typed values as-is.
  const onRaceCreated = (editionId: string) => {
    const j = findEdition(editionId);
    if (j) pick(j);
    setManual(false);
    setShowAddRace(false);
    showToast(t("onboarding.race.addedToast"));
  };

  // Leaving the no-race step: synthesize a race-shaped target so buildPlan has a
  // timeline. Goal comes from the mid-pack suggestion (always defined for a valid
  // distance) so paces are sensible without asking a beginner for a finish time.
  const finishTraining = () => {
    const g = suggestedGoalSec(fitDist) || "";
    const rd = addWeeks(horizon);
    setRaceDate(rd); setDist(fitDist); setGoal(g); setElev(0); setTargetEditionId(undefined); setPickedLabel("");
    go("hr", {raceDate: rd, distanceKm: fitDist, goalSec: g, raceElevation: 0, targetEditionId: null, planSessions, planStyle: effectiveStyle, trainingLevel: level, ...availMeta});
  };

  // Complete from the summary. HR is included only if the user entered any.
  // The derived age rides along so old app versions keep a consistent `age`.
  const complete = () => {
    const mhrN = parseInt(maxHR) || 0;
    const hasHR = ageN != null || mhrN > 0;
    const hr = hasHR ? {birthYear: byN, age: ageN ?? 0, maxHR: mhrN || tanakaMax || 0, restHR: parseInt(restHR) || 60} : null;
    const plan = {raceDate, goalSec, distanceKm, raceElevation: Number(raceElevation) || 0, planSessions, targetEditionId: targetEditionId || null, planStyle: effectiveStyle, trainingLevel: level, ...availMeta};
    onComplete({name: trimmedName, plan, hr, hrMethod: sensor ? "bluetooth" : null, healthAck: {v: DISCLAIMER_VERSION, at: new Date().toISOString()}});
  };

  // Text + band narrow the catalogue, same as the Races tab; a match passes the
  // band if its distance falls within it. With Near me on, split into
  // distance-sorted (within radius) + a location-unknown bucket — races beyond
  // the radius drop out, mirroring FindPanel.
  const matchesBand = (e: JoinedEdition) => band == null || Math.abs(e.edition.distanceKm - band) <= band * 0.12;
  const editionBase = searchEditions(query, today).filter(matchesBand);
  let editionResults: { e: JoinedEdition; distM: number | null }[];
  const unlocatedEditions: JoinedEdition[] = [];
  if (nearMe && loc) {
    const withCoord: { e: JoinedEdition; distM: number }[] = [];
    for (const e of editionBase) {
      if (e.lat == null || e.lng == null) { unlocatedEditions.push(e); continue; }
      const distM = haversineM(loc, { lat: e.lat as number, lng: e.lng as number });
      if (distM > radius * 1000) continue;
      withCoord.push({ e, distM });
    }
    withCoord.sort((a, b) => a.distM - b.distM);
    editionResults = withCoord;
  } else {
    editionResults = editionBase.map(e => ({ e, distM: null }));
  }

  // Plain-language, highest-risk PAR-Q items (placeholder wording — have a
  // qualified professional review before launch).
  const healthItems = [
    t("onboarding.health.item1"),
    t("onboarding.health.item2"),
    t("onboarding.health.item3"),
    t("onboarding.health.item4"),
  ];

  const distOptions = [
    {km: 5,       label: t("onboarding.training.d5.label"),    sub: t("onboarding.training.d5.sub")},
    {km: 10,      label: t("onboarding.training.d10.label"),   sub: t("onboarding.training.d10.sub")},
    {km: 21.0975, label: t("onboarding.training.dHalf.label"), sub: t("onboarding.training.dHalf.sub")},
    {km: 5,       label: t("onboarding.training.dMore.label"), sub: t("onboarding.training.dMore.sub"), key: "more"},
  ];

  return (
    <div className="fixed inset-0 bg-slate-900 z-50 flex flex-col animate-view-fade">
      <header className="flex items-center justify-between px-4 border-b border-slate-800 shrink-0"
        style={{height:"calc(44px + var(--safe-top))", paddingTop:"var(--safe-top)"}}>
        <div className="flex items-center gap-2">
          {stepIdx > 0 && (
            <button onClick={back}
              className="flex items-center gap-0.5 text-xs text-slate-400 hover:text-white transition-colors -ml-1 pr-1">
              <ChevronLeft size={16}/>{t("onboarding.back")}
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {seq.map((_, i) => (
            <span key={i}
              className={"h-1.5 rounded-full transition-all " + (i === stepIdx ? "w-5 bg-orange-400" : "w-1.5 bg-slate-700")}/>
          ))}
        </div>
        {cur === "health" || cur === "summary" ? (
          <span className="w-8"/>
        ) : (
          // "Skip" the optional setup — but funnel to the mandatory health step
          // rather than out of onboarding, so the gate can't be bypassed.
          <button onClick={skip}
            className="text-xs text-slate-400 hover:text-white transition-colors">
            {t("onboarding.skip")}
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-sm mx-auto p-5" style={{paddingBottom:"calc(1.25rem + var(--safe-bottom))"}}>
          <p className="text-xs text-slate-500 mb-4">{t("onboarding.stepOf", {step: stepIdx + 1, total: seq.length})}</p>

          {cur === "welcome" && (
            <div className="text-center space-y-5">
              <div className="w-12 h-12 rounded-full bg-orange-500/15 flex items-center justify-center mx-auto">
                <Activity size={22} className="text-orange-400"/>
              </div>
              <div>
                <p className="font-bold text-lg">{t("onboarding.welcome.title")}</p>
                <p className="text-sm text-slate-400 mt-1">{t("onboarding.welcome.subtitle")}</p>
              </div>
              <ul className="text-left space-y-2.5 bg-slate-800 rounded-2xl p-4">
                {[
                  {Icon: Target, text: t("onboarding.welcome.featurePlan")},
                  {Icon: MapPin, text: t("onboarding.welcome.featureGps")},
                  {Icon: Trophy, text: t("onboarding.welcome.featureBadges")},
                ].map(({Icon, text}, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-sm text-slate-300">
                    <Icon size={16} className="text-orange-400 shrink-0 mt-0.5"/>{text}
                  </li>
                ))}
              </ul>
              <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t("settings.language.label")}>
                {LANGS.map(l => (
                  <button key={l.id} type="button" onClick={() => pickLang(l.id)}
                    role="radio" aria-checked={uiLang === l.id}
                    className={"py-2 rounded-xl text-sm font-semibold transition-colors " +
                      (uiLang === l.id ? "bg-orange-500 text-white" : "bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-200")}>
                    {l.label}
                  </button>
                ))}
              </div>
              <div className="space-y-2">
                <input autoFocus type="text" value={name} maxLength={40}
                  onChange={e => setName(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") go("intent", {name: trimmedName}); }}
                  placeholder={t("onboarding.welcome.namePlaceholder")}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm text-white text-center focus:outline-none focus:border-orange-400 placeholder-slate-500"/>
                <button onClick={() => go("intent", {name: trimmedName})}
                  className="w-full bg-orange-500 hover:bg-orange-600 text-white py-2.5 rounded-xl text-sm font-semibold transition-colors">
                  {t("onboarding.getStarted")}
                </button>
              </div>
            </div>
          )}

          {cur === "intent" && (
            <div className="space-y-5">
              <div>
                <p className="font-bold text-lg">{trimmedName ? t("onboarding.intent.titleNamed", {name: trimmedName}) : t("onboarding.intent.title")}</p>
                <p className="text-sm text-slate-400 mt-1">{t("onboarding.intent.subtitle")}</p>
              </div>
              <div className="space-y-3">
                <button onClick={() => go("race", {}, "race")}
                  className="w-full text-left bg-slate-800 rounded-2xl p-4 border border-slate-700 hover:border-orange-400/60 transition-colors flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-orange-500/15 flex items-center justify-center shrink-0">
                    <Trophy size={20} className="text-orange-400"/>
                  </div>
                  <div>
                    <p className="font-semibold">{t("onboarding.intent.race.title")}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{t("onboarding.intent.race.sub")}</p>
                  </div>
                </button>
                <button onClick={() => go("training", {}, "fitness")}
                  className="w-full text-left bg-slate-800 rounded-2xl p-4 border border-slate-700 hover:border-orange-400/60 transition-colors flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-orange-500/15 flex items-center justify-center shrink-0">
                    <Sparkles size={20} className="text-orange-400"/>
                  </div>
                  <div>
                    <p className="font-semibold">{t("onboarding.intent.fitness.title")}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{t("onboarding.intent.fitness.sub")}</p>
                  </div>
                </button>
              </div>
            </div>
          )}

          {cur === "race" && (
            <div className="space-y-5">
              <div>
                <p className="font-bold text-lg">{t("onboarding.race.title")}</p>
                <p className="text-sm text-slate-400 mt-1">{t("onboarding.race.subtitle")}</p>
              </div>

              {pickedLabel ? (
                <div className="bg-slate-800 rounded-2xl p-4 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0">
                    <Check size={18} className="text-emerald-400"/>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold truncate">{pickedLabel}</p>
                    <p className="text-xs text-slate-400">{fmt.date(raceDate) + " · " + distanceKm + " km" + (raceElevation ? " · +" + raceElevation + "m" : "")}</p>
                  </div>
                  <button onClick={clearPick} className="text-xs text-slate-400 hover:text-white shrink-0">{t("onboarding.race.change")}</button>
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <div className="relative">
                      <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"/>
                      <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder={t("onboarding.race.searchPlaceholder")}
                        className={INPUT_CLS + " pl-9"}/>
                    </div>
                    <div className="flex gap-1.5 flex-wrap items-center">
                      <span className="text-[11px] text-slate-500 mr-1">{t("races.find.distance")}</span>
                      <Chip active={band == null} onClick={() => setBand(null)}>{t("races.find.all")}</Chip>
                      {BANDS.map(b => <Chip key={b} active={band === b} onClick={() => setBand(band === b ? null : b)}>{b} km</Chip>)}
                    </div>
                    <div className="flex gap-1.5 flex-wrap items-center">
                      <button onClick={toggleNearMe} disabled={locStatus === "locating"}
                        className={"inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition-colors border disabled:opacity-60 " +
                          (nearMe ? "bg-orange-500 text-white border-orange-500" : "bg-slate-800 text-slate-300 border-slate-700 hover:border-slate-500")}>
                        {locStatus === "locating" ? <Loader size={13} className="animate-spin"/> : <Navigation size={13}/>}
                        {t("races.find.nearMe")}
                      </button>
                      {nearMe && <span className="text-[11px] text-slate-500 mx-1">{t("races.find.within")}</span>}
                      {nearMe && RADII.map(r => <Chip key={r} active={radius === r} onClick={() => setRadius(r)}>{r} km</Chip>)}
                    </div>
                    {locStatus === "denied" && (
                      <p className="text-xs text-red-400">{t("races.find.locationDenied")}</p>
                    )}
                  </div>
                  {editionResults.length === 0 && unlocatedEditions.length === 0 && (
                    <p className="text-xs text-slate-500">{nearMe ? t("races.find.noneInRadius", { radius }) : t("races.find.noMatch")}</p>
                  )}
                  {(editionResults.length > 0 || unlocatedEditions.length > 0) && (
                    <div className="space-y-2 max-h-72 overflow-y-auto">
                      {editionResults.slice(0, 25).map(({ e, distM }) => (
                        <button key={e.edition.id} onClick={() => pick(e)}
                          className="w-full text-left bg-slate-800 rounded-xl border border-slate-700 px-4 py-3 hover:border-orange-400/50 transition-colors">
                          <p className="font-semibold truncate">{String(e.name)}</p>
                          <p className="text-xs text-slate-400">{[e.city, e.country].filter(Boolean).join(", ") + " · " + fmt.date(e.edition.date) + " · " + e.edition.distanceKm + " km"}
                            {distM != null && " · " + t("races.card.away", { dist: fmtKm(distM) })}</p>
                        </button>
                      ))}
                      {nearMe && unlocatedEditions.length > 0 && (
                        <>
                          <p className="text-[11px] text-slate-500 uppercase tracking-widest pt-1">{t("races.find.locationUnknown")}</p>
                          {unlocatedEditions.slice(0, 25).map(e => (
                            <button key={e.edition.id} onClick={() => pick(e)}
                              className="w-full text-left bg-slate-800 rounded-xl border border-slate-700 px-4 py-3 hover:border-orange-400/50 transition-colors">
                              <p className="font-semibold truncate">{String(e.name)}</p>
                              <p className="text-xs text-slate-400">{[e.city, e.country].filter(Boolean).join(", ") + " · " + fmt.date(e.edition.date) + " · " + e.edition.distanceKm + " km"}</p>
                            </button>
                          ))}
                        </>
                      )}
                    </div>
                  )}

                  <AddRaceCard onClick={() => setShowAddRace(true)} subtitle={t("onboarding.race.addSubtitle")}>
                    {!manual ? (
                      <button onClick={() => setManual(true)} className="text-xs text-slate-400 hover:text-slate-200 transition-colors">
                        {t("onboarding.race.manualLink")}
                      </button>
                    ) : (
                      <div className="space-y-4 pt-1">
                        <div>
                          <label className="text-xs text-slate-400 block mb-1.5">{t("onboarding.race.dateLabel")}</label>
                          <input type="date" value={raceDate} onChange={e => { setRaceDate(e.target.value); onManualEdit(); }}
                            className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-white text-sm focus:outline-none focus:border-orange-400"/>
                        </div>
                        <div>
                          <label className="text-xs text-slate-400 block mb-1.5">{t("onboarding.race.distanceLabel")}</label>
                          <input type="number" min="1" max="200" step="0.1" value={distanceKm} placeholder={t("onboarding.race.distancePlaceholder")}
                            onChange={e => { const n = parseFloat(e.target.value); setDist(isNaN(n) ? "" : n); onManualEdit(); }}
                            className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-white text-sm focus:outline-none focus:border-orange-400 placeholder-slate-500"/>
                        </div>
                        <div>
                          <label className="text-xs text-slate-400 block mb-1.5">{t("onboarding.race.elevationLabel")}</label>
                          <input type="number" min="0" max="10000" step="10" value={raceElevation} placeholder="0"
                            onChange={e => { const v = e.target.value; setElev(v === "" ? "" : Math.max(0, parseInt(v) || 0)); onManualEdit(); }}
                            className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-white text-sm focus:outline-none focus:border-orange-400 placeholder-slate-500"/>
                          <p className="text-slate-500 text-xs mt-1">{t("onboarding.race.elevationHint")}</p>
                        </div>
                      </div>
                    )}
                  </AddRaceCard>
                </>
              )}

              <button onClick={() => go("raceGoal", {raceDate, distanceKm, raceElevation: Number(raceElevation) || 0, targetEditionId})} disabled={!raceDate || !distanceKm}
                className="w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-white py-2.5 rounded-xl text-sm font-semibold transition-colors">
                {t("onboarding.continue")}
              </button>
            </div>
          )}

          {cur === "raceGoal" && (
            <div className="space-y-5">
              <div>
                <p className="font-bold text-lg">{t("onboarding.raceGoal.title")}</p>
                <p className="text-sm text-slate-400 mt-1">{t("onboarding.raceGoal.subtitle")}</p>
              </div>
              <LevelTiles value={level} onChange={setLevel}/>
              <GoalConfigurator distanceKm={distanceKm} goalSec={goalSec} onChange={setGoal}/>
              <AvailabilityStep mode={availMode} setMode={setAvailMode} days={availDays} band={availBand}
                sessions={customSessions} distanceKm={distanceKm} trainingLevel={level}
                onDaysChange={n => setAvailDays(clampDays(n))} onBandChange={setAvailBand} onSessionsChange={setSess}/>
              <div>
                <label className="text-xs text-slate-400 block mb-2">{t("onboarding.styleLabel")}</label>
                <StylePicker value={effectiveStyle} onChange={setPlanStyle} recommended={recommendedStyle}/>
              </div>
              <button onClick={() => go("hr", {goalSec, planSessions, planStyle: effectiveStyle, trainingLevel: level, ...availMeta})}
                className="w-full bg-orange-500 hover:bg-orange-600 text-white py-2.5 rounded-xl text-sm font-semibold transition-colors">
                {t("onboarding.continue")}
              </button>
            </div>
          )}

          {cur === "training" && (
            <div className="space-y-5">
              <div>
                <p className="font-bold text-lg">{t("onboarding.training.title")}</p>
                <p className="text-sm text-slate-400 mt-1">{t("onboarding.training.subtitle")}</p>
              </div>
              <LevelTiles value={level} onChange={setLevel}/>
              <div>
                <label className="text-xs text-slate-400 block mb-2">{t("onboarding.training.buildLabel")}</label>
                <div className="grid grid-cols-2 gap-2">
                  {distOptions.map(o => {
                    const id = o.key || String(o.km);
                    const selected = (selKey === id);
                    return (
                      <button key={id} onClick={() => { setSelKey(id); setFitDist(o.km); }}
                        className={"text-left rounded-xl border p-3 transition-colors " + (selected
                          ? "bg-orange-500/15 border-orange-500/60"
                          : "bg-slate-800 border-slate-700 hover:border-slate-600")}>
                        <p className="font-semibold text-sm">{o.label}</p>
                        <p className="text-xs text-slate-400">{o.sub}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-2">{t("onboarding.training.horizonLabel")}</label>
                <div className="grid grid-cols-3 gap-2">
                  {[8, 12, 16].map(w => (
                    <button key={w} onClick={() => setHorizon(w)}
                      className={"py-2.5 rounded-xl border text-sm font-semibold transition-colors " + (horizon === w
                        ? "bg-orange-500 text-white border-orange-500"
                        : "bg-slate-800 border-slate-700 text-slate-400 hover:text-white")}>
                      {t("onboarding.training.weeks", {count: w})}
                    </button>
                  ))}
                </div>
              </div>
              <AvailabilityStep mode={availMode} setMode={setAvailMode} days={availDays} band={availBand}
                sessions={customSessions} distanceKm={fitDist} trainingLevel={level}
                onDaysChange={n => setAvailDays(clampDays(n))} onBandChange={setAvailBand} onSessionsChange={setSess}/>
              <div>
                <label className="text-xs text-slate-400 block mb-2">{t("onboarding.styleLabel")}</label>
                <StylePicker value={effectiveStyle} onChange={setPlanStyle} recommended={recommendedStyle}/>
              </div>
              <button onClick={finishTraining}
                className="w-full bg-orange-500 hover:bg-orange-600 text-white py-2.5 rounded-xl text-sm font-semibold transition-colors">
                {t("onboarding.continue")}
              </button>
            </div>
          )}

          {cur === "hr" && (
            <div className="space-y-5">
              <div>
                <p className="font-bold text-lg">{t("onboarding.hr.title")}</p>
                <p className="text-sm text-slate-400 mt-1">{t("onboarding.hr.subtitle")}</p>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div><label className="text-xs text-slate-400 block mb-1.5">{t("onboarding.hr.birthYear")}</label>
                  <input type="number" min={thisYear - 90} max={thisYear - 10} placeholder="1990" value={birthYear} onChange={e => setBirthYear(e.target.value)} className={INPUT_CLS}/></div>
                <div><label className="text-xs text-slate-400 block mb-1.5">{t("onboarding.hr.maxHR")}</label>
                  <input type="number" min="100" max="230" placeholder={t("onboarding.hr.autoPlaceholder")} value={maxHR} onChange={e => setMaxHR(e.target.value)} className={INPUT_CLS}/></div>
                <div><label className="text-xs text-slate-400 block mb-1.5">{t("onboarding.hr.restHR")}</label>
                  <input type="number" min="30" max="120" placeholder="60" value={restHR} onChange={e => setRestHR(e.target.value)} className={INPUT_CLS}/></div>
              </div>

              {isNative && (
                <div className="bg-slate-800 rounded-2xl p-3 space-y-2">
                  <p className="text-sm font-semibold text-slate-200">{t("onboarding.hr.sensorTitle")}</p>
                  <p className="text-xs text-slate-400">{t("onboarding.hr.sensorBody")}</p>
                  {sensor ? (
                    <p className="text-xs text-emerald-300 flex items-center gap-1.5">
                      <Check size={13} className="shrink-0"/>{t("onboarding.hr.sensorPaired", { name: sensor.name })}
                    </p>
                  ) : sensorOpen ? (
                    <BleScanList pairing={sensorPairing}/>
                  ) : (
                    <button type="button" onClick={() => { setSensorOpen(true); sensorPairing.startScan(); }}
                      className="w-full py-2.5 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center justify-center gap-2 transition-colors">
                      <Bluetooth size={15}/>{t("onboarding.hr.sensorCta")}
                    </button>
                  )}
                </div>
              )}

              <div>
                {!(parseInt(maxHR) || 0) && (
                  <button type="button" onClick={estimateHR}
                    className="text-xs text-sky-300 hover:text-sky-200 underline underline-offset-2 transition-colors">
                    {t("onboarding.hr.dontKnow")}
                  </button>
                )}
                {maxHRHint && <p className="text-xs text-slate-500 mt-1.5">{maxHRHint}</p>}
              </div>

              <button onClick={() => go("health")}
                className="w-full bg-orange-500 hover:bg-orange-600 text-white py-2.5 rounded-xl text-sm font-semibold transition-colors">
                {t("onboarding.continue")}
              </button>
            </div>
          )}

          {cur === "health" && (
            <div className="space-y-5">
              <div className="text-center space-y-3">
                <div className="w-12 h-12 rounded-full bg-orange-500/15 flex items-center justify-center mx-auto">
                  <ShieldAlert size={22} className="text-orange-400"/>
                </div>
                <div>
                  <p className="font-bold text-lg">{t("onboarding.health.title")}</p>
                  <p className="text-sm text-slate-400 mt-1">{t("onboarding.health.subtitle")}</p>
                </div>
              </div>

              <div className="bg-slate-800 rounded-2xl p-4 space-y-3">
                <p className="text-sm text-slate-200">{t("onboarding.health.question")}</p>
                <ul className="space-y-1.5">
                  {healthItems.map((item, i) => (
                    <li key={i} className="flex gap-2 text-xs text-slate-400">
                      <span className="text-orange-400 shrink-0">•</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
                <div className="grid grid-cols-2 gap-2 pt-0.5">
                  {[{v:false, l:t("onboarding.health.no")}, {v:true, l:t("onboarding.health.yes")}].map(opt => (
                    <button key={opt.l} onClick={() => setScreenApplies(opt.v)}
                      className={"py-2.5 rounded-xl border text-sm font-semibold transition-colors " + (
                        screenApplies === opt.v
                          ? (opt.v ? "bg-red-500/15 border-red-500/50 text-red-300" : "bg-emerald-500/15 border-emerald-500/50 text-emerald-300")
                          : "bg-slate-700 border-slate-600 text-slate-400 hover:text-slate-200")}>
                      {opt.l}
                    </button>
                  ))}
                </div>
              </div>

              {flagged && (
                <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4 space-y-3">
                  <div className="flex items-start gap-2">
                    <AlertTriangle size={18} className="text-red-400 shrink-0 mt-0.5"/>
                    <div>
                      <p className="text-sm font-semibold text-red-200">{t("onboarding.health.doctorTitle")}</p>
                      <p className="text-xs text-red-200/80 mt-1">{t("onboarding.health.doctorBody")}</p>
                    </div>
                  </div>
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input type="checkbox" checked={medConfirm} onChange={e => setMedConfirm(e.target.checked)}
                      className="mt-0.5 w-4 h-4 rounded accent-orange-500 shrink-0"/>
                    <span className="text-xs text-red-100">{t("onboarding.health.doctorConfirm")}</span>
                  </label>
                </div>
              )}

              {/* Medical / liability disclaimer — PLACEHOLDER copy, pending review
                  by a qualified lawyer before launch. Do not treat as final. */}
              <div className="bg-slate-800 rounded-2xl p-4 space-y-3">
                <p className="text-sm font-semibold text-slate-200">{t("onboarding.health.disclaimerTitle")}</p>
                <p className="text-xs text-slate-400 leading-relaxed">{t("onboarding.health.disclaimerBody")}</p>
                <a href={DISCLAIMER_URL} target="_blank" rel="noopener noreferrer"
                  className="inline-block text-xs text-orange-400 hover:text-orange-300">
                  {t("onboarding.health.readFull")}
                </a>
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input type="checkbox" checked={ackChecked} onChange={e => setAckChecked(e.target.checked)}
                    className="mt-0.5 w-4 h-4 rounded accent-orange-500 shrink-0"/>
                  <span className="text-xs text-slate-200">{t("onboarding.health.ack")}</span>
                </label>
              </div>

              <button onClick={() => go("summary")} disabled={!canPassHealth}
                className="w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-white py-2.5 rounded-xl text-sm font-semibold transition-colors">
                {t("onboarding.continue")}
              </button>
            </div>
          )}

          {cur === "summary" && (() => {
            const preview = buildPlan(raceDate, goalSec, planSessions, distanceKm, raceElevation, {style: effectiveStyle, level});
            const weeks = preview?.weeks?.length || 0;
            const label = pickedLabel || (intent === "fitness" ? t("onboarding.summary.fallbackFitness") : t("onboarding.summary.fallbackRace"));
            return (
              <div className="space-y-5 text-center">
                <Confetti/>
                <div className="w-12 h-12 rounded-full bg-emerald-500/15 flex items-center justify-center mx-auto animate-pop">
                  <Check size={24} className="text-emerald-400"/>
                </div>
                <div>
                  <p className="font-bold text-lg">{trimmedName ? t("onboarding.summary.titleNamed", {name: trimmedName}) : t("onboarding.summary.title")}</p>
                  <p className="text-sm text-slate-400 mt-1">{t("onboarding.summary.subtitle")}</p>
                </div>
                <div className="bg-slate-800 rounded-2xl p-4 space-y-3 text-left">
                  <div className="flex items-center gap-3">
                    <Target size={18} className="text-orange-400 shrink-0"/>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{label}</p>
                      <p className="text-xs text-slate-400">{t(intent === "fitness" ? "onboarding.summary.metaGoal" : "onboarding.summary.meta", {km: distanceKm, date: fmt.date(raceDate)})}</p>
                    </div>
                  </div>
                  <div className="border-t border-slate-700/50 pt-3 grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-xl font-bold text-orange-300">{weeks}</p>
                      <p className="text-xs text-slate-400">{t("onboarding.summary.weekPlan")}</p>
                    </div>
                    <div>
                      <p className="text-xl font-bold text-orange-300">{planSessions.length}</p>
                      <p className="text-xs text-slate-400">{t("onboarding.summary.sessionsPerWeek")}</p>
                    </div>
                  </div>
                </div>
                {/* The one place onboarding signposts the coach. Teaching by
                    example (phrases a runner would actually type) rather than by
                    feature list, and the propose-and-confirm guarantee, which is
                    otherwise only discoverable by opening the chat. */}
                <div className="bg-slate-800 rounded-2xl p-4 space-y-3 text-left">
                  <div className="flex items-center gap-2.5">
                    <CoachAvatar chip size={15} className="w-7 h-7"/>
                    <p className="text-sm font-semibold">{t("onboarding.summary.coach.title")}</p>
                  </div>
                  <div className="space-y-1.5">
                    {(["ex1", "ex2", "ex3"] as const).map(k => (
                      <p key={k} className="text-xs text-slate-300 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5">
                        {t("onboarding.summary.coach." + k)}
                      </p>
                    ))}
                  </div>
                  <p className="text-xs text-sky-300">{t("onboarding.summary.coach.guarantee")}</p>
                </div>
                <button onClick={complete}
                  className="w-full bg-orange-500 hover:bg-orange-600 text-white py-2.5 rounded-xl text-sm font-semibold transition-colors">
                  {t("onboarding.getStarted")}
                </button>
              </div>
            );
          })()}
        </div>
      </div>

      {showAddRace && <RaceFormModal
        catalogue={catalogue} addRace={addRace} addEdition={addEdition}
        onContributed={refreshCatalogue} showToast={showToast}
        prefill={{date: raceDate, distanceKm, elevation: Number(raceElevation) || 0}}
        onCreated={onRaceCreated}
        onClose={() => setShowAddRace(false)}/>}
    </div>
  );
}

// The one-question fitness signal ("How much do you run right now?"), shared
// by both intent branches. Optional — the flow never blocks on it; unanswered
// just means the style recommendation stays history-free conservative.
function LevelTiles({ value, onChange }: { value: TrainingLevel | null; onChange: (l: TrainingLevel) => void }) {
  const { t } = useTranslation();
  return (
    <div>
      <label className="text-xs text-slate-400 block mb-2">{t("onboarding.level.label")}</label>
      <div className="grid grid-cols-2 gap-2">
        {trainingLevels().map(l => (
          <button key={l.id} onClick={() => onChange(l.id)}
            className={"text-left rounded-xl border p-3 transition-colors " + (value === l.id
              ? "bg-orange-500/15 border-orange-500/60"
              : "bg-slate-800 border-slate-700 hover:border-slate-600")}>
            <p className="font-semibold text-sm">{l.label}</p>
            <p className="text-xs text-slate-400">{l.sub}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

// Availability picker for onboarding: a Simple/Custom toggle above the shared
// AvailabilityEditor (day count + duration band, or exact days, with a weekly-load
// meter). Mirrors the Plan page's edit screen so the two never drift.
type AvailabilityStepProps = {
  mode: AvailabilityMode; setMode: (m: AvailabilityMode) => void;
  days: number; band: DurationBand; sessions: PlanSessionInput[]; distanceKm: number | string;
  trainingLevel?: unknown;
  onDaysChange: (n: number) => void; onBandChange: (b: DurationBand) => void; onSessionsChange: (s: PlanSessionInput[]) => void;
};

function AvailabilityStep({ mode, setMode, days, band, sessions, distanceKm, trainingLevel, onDaysChange, onBandChange, onSessionsChange }: AvailabilityStepProps) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="flex items-center justify-between mb-2 gap-2">
        <label className="text-xs text-slate-400">{t("onboarding.daysLabel")}</label>
        <div className="flex bg-slate-800 rounded-lg p-0.5 gap-0.5 flex-shrink-0">
          {(["simple", "custom"] as AvailabilityMode[]).map(m => (
            <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m}
              className={"px-3 py-1 rounded-md text-xs font-semibold transition-colors " +
                (mode === m ? "bg-orange-500 text-slate-900" : "text-slate-400 hover:text-slate-200")}>
              {t("plan.avail.mode." + m)}
            </button>
          ))}
        </div>
      </div>
      <AvailabilityEditor mode={mode} days={days} band={band} sessions={sessions} distanceKm={distanceKm}
        trainingLevel={trainingLevel}
        onDaysChange={onDaysChange} onBandChange={onBandChange} onSessionsChange={onSessionsChange}/>
    </div>
  );
}
