import { useTranslation } from "react-i18next";
import { RecorderSheet, Segmented, SheetLabel, Stepper } from "../components/RecorderSheet";
import { WorkoutTimeline } from "../components/WorkoutCard";
import { fmt } from "../utils/format";
import { WORKOUT_TYPES, compileSpec, isOpenSpec, type WorkoutSpec } from "../utils/workoutSpec";

// "Today's run": what this recording is — kind of run, distance or duration,
// structure, pace and heart-rate targets. Seeded from the plan session when
// there is one; edits apply to this run only (docs/guided-workouts.md).

type NumKey = "pace" | "warmMin" | "coolMin" | "blockKm" | "blockMin" | "reps" | "repM" | "repSec"
  | "recSec" | "recM" | "runSec" | "walkSec" | "goalKm" | "goalMin";

const STEP: Record<NumKey, [step: number, min: number, max: number]> = {
  pace: [5, 150, 600], warmMin: [1, 0, 30], coolMin: [1, 0, 30],
  blockKm: [0.5, 0.5, 42], blockMin: [5, 5, 120], reps: [1, 1, 30],
  repM: [100, 100, 5000], repSec: [15, 15, 1200], recSec: [15, 15, 600], recM: [100, 100, 2000],
  runSec: [15, 15, 1200], walkSec: [15, 15, 600], goalKm: [0.5, 0.5, 100], goalMin: [5, 5, 360],
};

const HR_ZONE_OPTIONS: ([number, number] | null)[] = [
  null, [1, 1], [2, 2], [2, 3], [3, 3], [3, 4], [4, 4], [4, 5], [5, 5],
];

const sameZone = (a: [number, number] | null, b: [number, number] | null) =>
  a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
const DEFAULT_PACE = 330;

function UnitSwitch<T extends string>({ value, options, onChange, label }: {
  value: T; options: [T, string][]; onChange: (v: T) => void; label: string;
}) {
  return (
    <span role="radiogroup" aria-label={label} className="mt-1 inline-flex gap-0.5 rounded-md bg-slate-800 p-0.5">
      {options.map(([v, l]) => (
        <button key={v} role="radio" aria-checked={v === value} onClick={() => onChange(v)}
          className={"rounded px-2 py-0.5 text-[11px] " + (v === value ? "bg-slate-600 text-white" : "text-slate-400")}>{l}</button>
      ))}
    </span>
  );
}

export function WorkoutSheet({ spec, fromPlan, edited, band, zoneBpm, onChange, onRestore, onClose }: {
  spec: WorkoutSpec;
  /** Short description of the plan session this came from, or null on a free run. */
  fromPlan: string | null;
  edited: boolean;
  band: number;
  zoneBpm: (zone: [number, number] | null) => { lo: number; hi: number } | null;
  onChange: (spec: WorkoutSpec) => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<WorkoutSpec>) => onChange({ ...spec, ...patch });
  const bump = (key: NumKey) => (dir: 1 | -1) => {
    const [step, min, max] = STEP[key];
    const cur = key === "pace" ? spec.pace ?? DEFAULT_PACE : spec[key];
    set({ [key]: Math.min(max, Math.max(min, Math.round((cur + dir * step) * 10) / 10)) });
  };
  const zoneIdx = Math.max(0, HR_ZONE_OPTIONS.findIndex(z => sameZone(z, spec.hrZone)));
  const zone = spec.hrZone;
  const bpm = zoneBpm(zone);
  const mins = (m: number) => m > 0 ? t("tracker.guided.mins", { mins: m }) : t("tracker.setup.none");
  const preview = compileSpec(spec, { band, hr: bpm });

  return (
    <RecorderSheet title={t("tracker.setup.title.sheet")} onClose={onClose}>
      {fromPlan && (
        <div className="flex items-center gap-2 rounded-xl border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-xs text-orange-200">
          <span className="flex-1">{edited ? t("tracker.setup.thisRunOnly") : t("tracker.setup.fromPlan", { session: fromPlan })}</span>
          {edited && <button onClick={onRestore} className="underline font-semibold">{t("tracker.setup.usePlan")}</button>}
        </div>
      )}

      <SheetLabel>{t("tracker.setup.typeLabel")}</SheetLabel>
      <Segmented label={t("tracker.setup.typeLabel")} value={spec.type}
        options={WORKOUT_TYPES.map(v => ({ value: v, label: t("tracker.setup.type." + v) }))}
        onChange={type => set({ type, ...(type === "tempo" || type === "intervals") && spec.pace == null ? { pace: DEFAULT_PACE } : {} })} />
      <p className="text-xs text-slate-400">{t("tracker.setup.typeDesc." + spec.type)}</p>

      {spec.type === "regular" && (
        <>
          <SheetLabel>{t("tracker.setup.goal")}</SheetLabel>
          <Segmented label={t("tracker.setup.goal")} value={spec.goal}
            options={(["open", "km", "time"] as const).map(v => ({ value: v, label: t("tracker.setup.goalOpt." + v) }))}
            onChange={goal => set({ goal })} />
          {spec.goal === "km" && <Stepper name={t("tracker.setup.distance")} value={`${spec.goalKm} km`} onStep={bump("goalKm")} />}
          {spec.goal === "time" && <Stepper name={t("tracker.setup.duration")} value={fmt.mins(spec.goalMin)} onStep={bump("goalMin")} />}
        </>
      )}

      {spec.type !== "regular" && (
        <>
          <SheetLabel>{t("tracker.setup.structure")}</SheetLabel>
          <Stepper name={t("tracker.guided.label.warmup")} value={mins(spec.warmMin)} muted={!spec.warmMin} onStep={bump("warmMin")} />
          {spec.type === "tempo" && (
            <Stepper name={t("tracker.setup.block")} onStep={bump(spec.blockUnit === "km" ? "blockKm" : "blockMin")}
              value={spec.blockUnit === "km" ? `${spec.blockKm} km` : mins(spec.blockMin)}>
              <UnitSwitch label={t("tracker.setup.block")} value={spec.blockUnit} onChange={blockUnit => set({ blockUnit })}
                options={[["km", "km"], ["min", "min"]]} />
            </Stepper>
          )}
          {spec.type === "intervals" && (
            <>
              <Stepper name={t("tracker.setup.reps")} value={String(spec.reps)} onStep={bump("reps")} />
              <Stepper name={t("tracker.setup.rep")} onStep={bump(spec.repUnit === "m" ? "repM" : "repSec")}
                value={spec.repUnit === "m" ? `${spec.repM} m` : mmss(spec.repSec)}>
                <UnitSwitch label={t("tracker.setup.rep")} value={spec.repUnit} onChange={repUnit => set({ repUnit })}
                  options={[["m", t("tracker.setup.unitDist")], ["sec", t("tracker.setup.unitTime")]]} />
              </Stepper>
              <Stepper name={t("tracker.guided.label.recover")} onStep={bump(spec.recUnit === "m" ? "recM" : "recSec")}
                value={spec.recUnit === "m" ? `${spec.recM} m` : mmss(spec.recSec)}>
                <UnitSwitch label={t("tracker.guided.label.recover")} value={spec.recUnit} onChange={recUnit => set({ recUnit })}
                  options={[["sec", t("tracker.setup.unitTime")], ["m", t("tracker.setup.unitDist")]]} />
              </Stepper>
            </>
          )}
          {spec.type === "runwalk" && (
            <>
              <Stepper name={t("tracker.guided.label.run")} value={mmss(spec.runSec)} onStep={bump("runSec")} />
              <Stepper name={t("tracker.guided.label.walk")} value={mmss(spec.walkSec)} onStep={bump("walkSec")} />
            </>
          )}
          {spec.type !== "runwalk" && (
            <Stepper name={t("tracker.guided.label.cooldown")} value={mins(spec.coolMin)} muted={!spec.coolMin} onStep={bump("coolMin")} />
          )}
        </>
      )}

      <SheetLabel>{t("tracker.setup.targets")}</SheetLabel>
      {spec.type !== "runwalk" && (
        <Stepper name={t(spec.type === "regular" ? "tracker.setup.pace" : "tracker.setup.workPace")}
          value={spec.pace ? `${fmt.pace(spec.pace)} /km` : t("tracker.setup.noTarget")} muted={!spec.pace}
          onStep={dir => spec.pace ? bump("pace")(dir) : set({ pace: DEFAULT_PACE })}>
          <UnitSwitch label={t("tracker.setup.pace")} value={spec.pace ? "set" : "none"}
            onChange={v => set({ pace: v === "set" ? spec.pace ?? DEFAULT_PACE : null })}
            options={[["set", t("tracker.setup.set")], ["none", t("tracker.setup.none")]]} />
        </Stepper>
      )}
      <Stepper name={t("tracker.setup.heartRate")} muted={!zone}
        value={zone ? `Z${zone[0]}${zone[1] !== zone[0] ? "-" + zone[1] : ""}${bpm ? ` · ${bpm.lo}-${bpm.hi}` : ""}` : t("tracker.setup.noTarget")}
        onStep={dir => set({ hrZone: HR_ZONE_OPTIONS[Math.min(HR_ZONE_OPTIONS.length - 1, Math.max(0, zoneIdx + dir))] })} />
      {zone && !bpm && <p className="text-xs text-amber-300/90">{t("tracker.setup.noProfile")}</p>}

      {!isOpenSpec(spec) && <div className="pt-1"><WorkoutTimeline workout={preview} pace={spec.pace} /></div>}
    </RecorderSheet>
  );
}
