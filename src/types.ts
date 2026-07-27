import type { PlanSessionInput } from "./utils/plan";

export type Intent = "race" | "fitness" | null;
// "healthconnect" is Android-only, "healthkit" iOS-only; the preference syncs
// across devices, so readers must degrade an off-platform value to "off"
// (getHrSource returns null for it) rather than assume it's usable locally.
export type HrMethod = "off" | "bluetooth" | "healthconnect" | "healthkit";
export type RunType = "EASY" | "TEMPO" | "INTERVALS" | "LONG" | "RACE" | "WALK" | "OTHER";

export type HealthAck = { v?: string | number; at?: string } | null;

export type SettingsState = Record<string, unknown> & {
  raceDate: string;
  goalSec: string | number;
  distanceKm: string | number;
  raceElevation: number;
  name: string;
  // Birth year (plain number, e.g. 1985 — deliberately not a full DOB, and no
  // gender). Age is derived at read time via runnerAge (src/utils/hr.ts) so it
  // never goes stale. Absent = unset.
  birthYear?: number;
  // Legacy static age — superseded by birthYear but still written on HR edits
  // so old app versions (which read/write only `age`) stay consistent. 0 = unset.
  age: number;
  maxHR: number;
  restHR: number;
  onboarded: boolean;
  onboardStep: number;
  intent: Intent;
  healthAck: HealthAck;
  hrMethod: HrMethod;
  hrOptOut: boolean;
  // Opt-in preference (synced) for importing finished runs from a watch via
  // Health Connect (Garmin, Zepp/Amazfit etc.). Like hrMethod it's a *preference
  // only* — the per-device WATCH_HC_AUTH_KEY marker must also be present before
  // the native Health Connect bridge is touched on a given install.
  watchImport?: boolean;
  // Enable-flags for any later import providers (see src/imports/registry.ts);
  // Health Connect keeps its own watchImport key above.
  imports?: Record<string, boolean>;
  planSessions: PlanSessionInput[];
  // How the user configured their weekly availability on the Plan page. Metadata
  // only — planSessions stays the source of truth for buildPlan. "simple" means
  // the coach placed the days (availDays + availTime chosen); "custom" means the
  // user picked exact days/durations. Absent ⇒ infer "custom" from planSessions.
  availabilityMode?: "simple" | "custom";
  availDays?: number;
  availTime?: "short" | "med" | "long";
  targetEditionId?: string | null;
  // Training methodology style (see src/utils/planStyles.ts); absent = balanced.
  planStyle?: string;
  // UI language (synced preference; see src/i18n). Absent = device/browser
  // locale. The per-device rc_lang localStorage key covers pre-auth screens.
  language?: "en" | "es" | "fr";
  // Self-reported running volume from onboarding ("none" | "occasional" |
  // "regular" | "frequent") — the fitness signal before any runs are logged.
  trainingLevel?: string | null;
};

export type HrPending = { start: string | number; end: string | number; source: string };

// Structured session descriptor. `desc` (English, canonical — what old clients
// render and the coach model reads) stays alongside; `sd` is what the UI
// renders per-locale via renderSd (src/utils/sessionDesc.ts). Pace is
// deliberately NOT here: sentences read it from session.pace at render time so
// a coach pace edit or a locale switch can never desync sentence and field.
// buildPlan (src/utils/plan.ts) and the coach's sdFor (supabase/functions/
// _shared/coach/tools.mjs) both stamp this; sessionDesc.test.ts proves both
// render to the canonical English `desc` byte-for-byte.
export type SessionSd = {
  kind: "long" | "easy" | "recovery" | "tempo" | "intervals" | "runwalk" | "cross" | "crosswalk" | "race" | "raceday";
  variant?: string;      // sentence flavor within a kind (1:1 with the English templates)
  reps?: number;         // rep/set count
  repM?: number;         // rep length in metres (400 | 600 | 800 | 1000 | 3000)
  recover?: "90s" | "90sJog" | "1kmJog" | "jogs";
  offsetSec?: number;    // Hansons strength: "goal pace minus 10s"
  runMin?: number;       // Galloway ratio
  walkMin?: number;
  minutes?: number;      // lowfreq cross-training day budget
  km?: number;           // race / raceday sentence figures
  elevM?: number;
};

export type Run = Record<string, unknown> & {
  id?: string;
  date: string;
  type?: RunType | string;
  km: number;
  durationSec?: number;
  hr?: number | null;
  hrMax?: number | null;
  elevation?: number | null;
  effort?: number | null;
  notes?: string;
  source?: string;
  routeId?: string;
  routeTmp?: string;
  routePending?: boolean;
  // A run_routes row that holds ONLY a raw HR series (stats.hrSamples) with no
  // GPS points — the common watch-import case where the health store has HR but
  // no route (Garmin/Samsung on Health Connect). Kept SEPARATE from routeId so
  // History's "view route" map button (gated on routeId) never offers a blank
  // map, while RunDetailModal still fetches it for the HR chart/time-in-zone
  // card. Old clients ignore the unknown field; deleteRun cascades it like routeId.
  hrRouteId?: string;
  hrPending?: HrPending | null;
  // The HealthKit twin of hrPending, deliberately a SEPARATE field: shipped
  // Android builds' flushPendingHr clears any hrPending whose source isn't
  // "healthconnect", so an iOS marker stored there would be destroyed through
  // the synced blob by an old phone. Old clients ignore unknown fields, so the
  // iOS marker rides here untouched until the iPhone resolves it.
  hrPendingHk?: HrPending | null;
  // Fastest contiguous 1K/5K/10K/half/marathon found inside this run's GPS
  // trace, in seconds, keyed by BestEffortKey (src/utils/bestEfforts.ts).
  // Extracted ONCE at save time, so every later PB comparison is an in-memory
  // scan of `runs` — no refetch of the trace, no server call. An empty object
  // means "measured, covers no standard distance"; absent means never measured
  // (a manual run, or a GPS run older than the feature), and readers fall back
  // to the whole-run estimate via effortsFor(). Old clients ignore the field.
  bestEfforts?: Record<string, number>;
  // Health Connect exercise-session id this run was imported from (source:"watch").
  // Used to dedupe repeated scans idempotently.
  hcId?: string;
  // Generic external id for other import providers (cloud APIs etc.) — same
  // dedupe role as hcId, one field per id-space so the two never collide.
  extId?: string;
  // ISO start instant of the run, when known (GPS-tracked or watch-imported).
  // Powers time-overlap dedupe between phone-tracked and watch-imported runs.
  startedAt?: string;
  wNum?: number;
  sId?: string;
};

export type PlanSession = Record<string, unknown> & {
  id: string;
  date: string;
  type: RunType | string;
  desc: string;
  sd?: SessionSd;
  km: number | string;
  pace: number;
  done?: boolean;
  skipped?: boolean;
  runId?: string | null;
  editionId?: string | null;
};

// A specific plan session handed to the coach chat so it opens "about this run"
// (the session's week + full session row). CoachChat derives both the localized
// display strings and the canonical-English context prefix from it.
export type CoachSessionContext = { session: PlanSession; weekNumber: number };

// Which affordance opened the coach chat. Analytics only (`coach_opened`) — it
// never changes what the coach is told. Pass one at every call site so the
// entry points stay comparable; "other" is the defensive fallback for a bare
// `onClick={openCoach}` wiring that hands us a click event instead.
export type CoachSource = "header" | "dashboard" | "plan_session" | "settings" | "other";

export type PlanWeek = Record<string, unknown> & {
  weekNumber: number;
  startDate?: string;
  phase?: string;
  sessions: PlanSession[];
};

export type Plan = Record<string, unknown> & {
  raceDate?: unknown;
  goalSec?: unknown;
  distanceKm?: unknown;
  raceElevation?: number;
  targetPace?: number;
  racePace?: number;
  longRunPeakKm?: number;
  planSessions?: PlanSessionInput[];
  // Methodology style the plan was built with; absent on pre-styles plans.
  style?: string;
  weeks: PlanWeek[];
};

export type PlanPrefill = {
  raceDate: string;
  distanceKm: number;
  raceElevation: number;
  editionId: string;
  label: string;
};

// A suggested LOOP route from the "Find a route" finder. This is NOT a recorded
// trace: it never touches run_routes / routeId, holds NO timestamps (nothing was
// run), and lives only in ephemeral client memory (the finder sheet + the
// tracker's plannedRoute overlay) until dismissal. A starred favourite is copied
// into the separate saved_routes table (see src/savedRoutes.ts).
export type SuggestedRoute = {
  id: string;                                 // local nonce, e.g. "sr" + seed
  points: [number, number, number | null][];  // [lat, lng, altM|null]
  km: number;                                 // measured via distanceKm()
  elevation: number;                          // measured via elevGainM()
  // i18n key SUFFIX for the one-line character ("mostlyPaths" | "mixed" |
  // "mostlyStreets"), resolved at render as t("routeFinder.character."+character).
  character?: string;
  // Scoring metadata (Phase 2), attached client-side; absent until scored.
  lengthErrorPct?: number;                    // |measured-target| / target, 0..1+
  overlapPct?: number;                        // self-overlap fraction, 0..1
};

export type RunPatch = Partial<Run>;
export type PlanProgress = Pick<PlanSession, "done" | "skipped" | "runId">;

export type RouteBackup = Record<string, unknown>;
export type UserContextState = { notes: string; lastLimitNoticeAt?: string | null };

export type ParticipationStatus = "wishlist" | "done" | "skipped" | string;

export type Participation = Record<string, unknown> & {
  editionId?: string | null;
  raceId?: string | null;
  label?: string;
  raceDate?: string;
  distanceKm?: number;
  status?: ParticipationStatus;
  inPlan?: boolean;
  timeSec?: number | null;
  runId?: string | null;
  source?: string;
  notes?: string;
};

export type RacesState = Record<string, unknown> & {
  participations: Participation[];
  seenBadges: string[] | null;
  ackVerified?: string[];
};

export type CatalogueEdition = Record<string, unknown> & {
  id: string;
  date: string;
  distanceKm: number;
  elevation?: number;
  createdBy?: string | null;
  verified?: boolean;
};

export type CatalogueRace = Record<string, unknown> & {
  id: string;
  slug?: string;
  name: string;
  city?: string | null;
  country?: string | null;
  lat?: number | null;
  lng?: number | null;
  distances?: number[];
  url?: string | null;
  createdBy?: string | null;
  verified?: boolean;
  editions: CatalogueEdition[];
};

export type JoinedEdition = CatalogueRace & {
  raceId: string;
  edition: CatalogueEdition;
};

export type RaceCandidate = { editionId?: string | null; date?: string; distanceKm?: string | number };

export type ToastAction = { label: string; onClick: () => void };
// Transient "these runs just changed" marker used to scroll to and highlight
// specific runs in the History list (async HR relink, watch import). `label` is
// the already-translated pill text ("New", "❤ added"). Cleared on a timeout.
export type RunHighlight = { ids: string[]; label: string };
// `id` monotonically increments per showToast call so back-to-back toasts remount
// (via `key`) and re-run the enter animation instead of silently swapping text.
export type ToastState = { id: number; msg: string; type: string; action?: ToastAction };
