import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import RunningCoach from "./RunningCoach";
import { STORAGE_KEYS } from "./constants";
import { buildPlan } from "./utils/plan";
import { buildOpenPlan, raceKey } from "./utils/openPlan";
import { track } from "./telemetry";
import { ymd } from "./utils/format";
import type { Plan, Run, SettingsState } from "./types";
import type { PlanSessionInput } from "./utils/plan";

// The automatic plan writes (open-plan extension, the start for a runner who
// never answered) and the "What's next?" prompt, driven through the hub.

let store: Record<string, unknown> = {};
let reconciled = true;
let loaded = true;

vi.mock("./db", () => ({
  db: {
    get: async (k: string) => store[k] ?? null,
    set: (k: string, v: unknown) => { store[k] = v; },
  },
  currentUserId: () => "test-user",
  flushNow: async () => {},
  isStoreLoaded: () => loaded,
  isStoreReconciled: () => reconciled,
}));
vi.mock("./races", () => ({ listRaces: async () => [], addRace: vi.fn(), addEdition: vi.fn(), reportRace: vi.fn() }));
vi.mock("./telemetry", () => ({ track: vi.fn() }));

const SESSIONS: PlanSessionInput[] = [{ dayOffset: 2, minutes: 45 }, { dayOffset: 6, minutes: 90 }];
const day = (n: number, from: string) => ymd(new Date(new Date(from + "T00:00:00").getTime() + n * 86400000));
const at = (date: string) => vi.setSystemTime(new Date(date + "T10:00:00"));

const RACE_DATE = "2026-10-04";
const settings = (over: Record<string, unknown> = {}) => ({
  name: "Ada", onboarded: true, raceDate: RACE_DATE, distanceKm: 10, goalSec: 3000, targetEditionId: null,
  planSessions: SESSIONS, planStyle: "balanced", ...over,
});

// A race plan whose race has been run and settled.
const racePlan = (): Plan => {
  at("2026-08-17");
  const p = buildPlan(RACE_DATE, 3000, SESSIONS, 10, 0, { recovery: true }) as unknown as Plan;
  return { ...p, weeks: p.weeks.map(w => ({ ...w, sessions: w.sessions.map(s => s.id === "race" ? { ...s, done: true, runId: "race-run" } : s) })) } as Plan;
};
const raceRun = { id: "race-run", date: RACE_DATE, type: "RACE", km: 10, durationSec: 2900, effort: 6 } as Run;
const easyRun = { id: "easy1", date: day(6, RACE_DATE), type: "EASY", km: 5, durationSec: 1800, effort: 3 } as Run;

const seed = (plan: Plan, runs: Run[], s: Record<string, unknown> = settings()) => {
  store = {
    [STORAGE_KEYS.SETTINGS]: s, [STORAGE_KEYS.PLAN]: plan, [STORAGE_KEYS.RUNS]: runs,
    [STORAGE_KEYS.RACES]: { participations: [], seenBadges: [] },
  };
};
const plan = () => store[STORAGE_KEYS.PLAN] as Plan;
const stored = () => store[STORAGE_KEYS.SETTINGS] as SettingsState;
const foreground = () => act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
const boot = async () => { render(<RunningCoach onSignOut={() => {}}/>); await act(async () => {}); await act(async () => {}); };

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); reconciled = true; loaded = true; });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe("RunningCoach · plan automation", () => {
  describe("an open plan keeps a block ahead", () => {
    const open = () => {
      at("2026-09-16");
      return buildOpenPlan(settings({ raceDate: "" }) as unknown as SettingsState, { target: "healthy", distanceKm: 10 }, { runs: [] });
    };
    const startOfLastBlock = (p: Plan) => day(-21, p.weeks[p.weeks.length - 1].startDate as string);

    it("appends the next blocks once the last one has started, and only once", async () => {
      const p = open();
      seed(p, [], settings({ raceDate: "", goalKind: "open", openTarget: "healthy" }));
      at(startOfLastBlock(p));
      await boot();
      const extended = plan();
      expect(extended.weeks.length).toBeGreaterThan(p.weeks.length);
      expect(extended.weeks.slice(0, p.weeks.length)).toEqual(p.weeks);
      expect(extended.goal?.extendedThrough).toBeTruthy();
      expect(track).toHaveBeenCalledWith("open_plan_extended", {});
      vi.mocked(track).mockClear();
      await foreground();
      await foreground();
      expect(plan()).toBe(extended);
      expect(track).not.toHaveBeenCalledWith("open_plan_extended", {});
    });

    it("does nothing before the last block", async () => {
      const p = open();
      seed(p, [], settings({ raceDate: "", goalKind: "open" }));
      at(day(-22, p.weeks[p.weeks.length - 1].startDate as string));
      await boot();
      expect(plan()).toBe(p);
    });

    it("waits for a reconciled store: an offline boot writes nothing, then does on the next foreground", async () => {
      const p = open();
      seed(p, [], settings({ raceDate: "", goalKind: "open" }));
      at(startOfLastBlock(p));
      reconciled = false;
      await boot();
      await foreground();
      expect(plan()).toBe(p);
      reconciled = true;
      await foreground();
      expect(plan().weeks.length).toBeGreaterThan(p.weeks.length);
    });

    it("waits for a loaded store", async () => {
      const p = open();
      seed(p, [], settings({ raceDate: "", goalKind: "open" }));
      at(startOfLastBlock(p));
      loaded = false;
      await boot();
      expect(plan()).toBe(p);
    });
  });

  describe("a runner who never answered 'what's next'", () => {
    it("gets a gentle plan three days after the recovery ended, if they ran during it", async () => {
      const p = racePlan();
      seed(p, [raceRun, easyRun]);
      at(day(3, p.recovery!.until));
      await boot();
      const next = plan();
      expect(next.goal).toMatchObject({ kind: "open", target: "healthy", autoFor: raceKey({ editionId: null, date: RACE_DATE }) });
      expect(next.raceDate).toBe("");
      expect(stored()).toMatchObject({ goalKind: "open", openTarget: "healthy", raceDate: "", lightPlan: false });
      expect(track).toHaveBeenCalledWith("open_plan_autostarted", { hadRuns: true });
      // The old plan stays as history, and the race is not a session of the new one.
      expect(next.weeks.some(w => w.sessions.some(s => s.id === "past-race"))).toBe(true);
      // Nothing more happens on the next foreground.
      vi.mocked(track).mockClear();
      await foreground();
      expect(plan()).toBe(next);
      expect(track).not.toHaveBeenCalledWith("open_plan_autostarted", expect.anything());
    });

    it("not the day before, and not with no run since the race", async () => {
      const p = racePlan();
      seed(p, [raceRun, easyRun]);
      at(day(2, p.recovery!.until));
      await boot();
      expect(plan()).toBe(p);
      cleanup();
      seed(p, [raceRun]);
      at(day(10, p.recovery!.until));
      await boot();
      expect(plan()).toBe(p);
    });

    it("not on an offline boot, before the store is reconciled", async () => {
      const p = racePlan();
      seed(p, [raceRun, easyRun]);
      at(day(5, p.recovery!.until));
      reconciled = false;
      await boot();
      expect(plan()).toBe(p);
      expect(stored().goalKind).toBeUndefined();
    });

    it("not once they have answered the sheet", async () => {
      const p = racePlan();
      seed(p, [raceRun, easyRun], settings({ whatsNextFor: raceKey({ editionId: null, date: RACE_DATE }) }));
      at(day(5, p.recovery!.until));
      await boot();
      expect(plan()).toBe(p);
    });

    it("never for a plan written before recovery existed", async () => {
      const p = racePlan();
      delete p.recovery;
      seed(p, [raceRun, easyRun]);
      at(day(60, RACE_DATE));
      await boot();
      expect(plan()).toBe(p);
    });
  });

  describe("the 'What's next?' sheet", () => {
    it("shows by itself when the recovery is over, and 'Not now' spends it", async () => {
      const p = racePlan();
      seed(p, [raceRun, easyRun]);
      at(day(1, p.recovery!.until));
      await boot();
      expect(screen.getByText("The training that got you here")).toBeInTheDocument();
      expect(track).toHaveBeenCalledWith("whats_next_shown", { variant: "afterRace" });
      fireEvent.click(screen.getByRole("button", { name: "Not now" }));
      expect(stored().whatsNextFor).toBe(raceKey({ editionId: null, date: RACE_DATE }));
      expect(track).toHaveBeenCalledWith("whats_next_answered", { variant: "afterRace", choice: "later" });
      expect(screen.queryByText("How are you feeling about running?")).toBeNull();
      // The quiet row is still there for later.
      expect(screen.getByRole("button", { name: /Set your next goal/ })).toBeInTheDocument();
    });

    it("recaps the block first, without the race in it", async () => {
      const p = racePlan();
      seed(p, [raceRun, easyRun, { id: "b", date: day(-5, RACE_DATE), type: "EASY", km: 8, durationSec: 2600 } as Run]);
      at(day(1, p.recovery!.until));
      await boot();
      expect(screen.getByText("The training that got you here")).toBeInTheDocument();
      // 8 km run in the block: the distance and the longest run. The race (10 km) and the run after it are not in it.
      expect(screen.getAllByText("8 km")).toHaveLength(2);
      expect(screen.getByText(/^0 of \d+$/)).toBeInTheDocument();
    });

    it("Keep improving builds a plan with no race, and Undo puts the race plan back", async () => {
      const p = racePlan();
      seed(p, [raceRun, easyRun]);
      at(day(1, p.recovery!.until));
      await boot();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      fireEvent.click(screen.getByRole("button", { name: /Steady/ }));
      fireEvent.click(screen.getByRole("button", { name: /Run further/ }));
      expect(plan().goal).toMatchObject({ kind: "open", target: "further" });
      expect(stored()).toMatchObject({ goalKind: "open", openTarget: "further", raceDate: "", whatsNextFor: raceKey({ editionId: null, date: RACE_DATE }) });
      expect(track).toHaveBeenCalledWith("whats_next_answered", { variant: "afterRace", choice: "improve", feeling: "steady", target: "further" });
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      expect(plan()).toEqual(p);
      expect(stored().raceDate).toBe(RACE_DATE);
    });

    it("a lighter plan is about two easy runs a week", async () => {
      const p = racePlan();
      seed(p, [raceRun, easyRun]);
      at(day(1, p.recovery!.until));
      await boot();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      fireEvent.click(screen.getByRole("button", { name: /Need a breather/ }));
      fireEvent.click(screen.getByRole("button", { name: "Start the lighter plan" }));
      expect(plan().goal).toMatchObject({ kind: "open", light: true });
      expect(stored().lightPlan).toBe(true);
    });

    it("waits for a pointer that is still to be spent", async () => {
      const p = racePlan();
      seed(p, [raceRun, easyRun], settings({ coachIntroSeen: false }));
      at(day(1, p.recovery!.until));
      await boot();
      expect(screen.queryByText("How are you feeling about running?")).toBeNull();
    });

    it("can be opened later from the quiet row", async () => {
      const p = racePlan();
      seed(p, [raceRun, easyRun], settings({ whatsNextFor: raceKey({ editionId: null, date: RACE_DATE }) }));
      at(day(1, p.recovery!.until));
      await boot();
      expect(screen.queryByText("How are you feeling about running?")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /Set your next goal/ }));
      expect(screen.getByText("The training that got you here")).toBeInTheDocument();
    });
  });

  describe("the race-first variant, for a runner who onboarded to be followed", () => {
    const wish = { editionId: "city-10k", label: "City 10K 2026", raceDate: "2026-10-04", distanceKm: 10, status: "wishlist", timeSec: null, runId: null, notes: "" };
    const seedLive = () => {
      store = {
        [STORAGE_KEYS.SETTINGS]: settings({ liveFirst: true, raceBridgeSeen: false, raceDate: "", distanceKm: "", goalSec: "" }),
        [STORAGE_KEYS.RUNS]: [], [STORAGE_KEYS.RACES]: { participations: [wish], seenBadges: [] },
      };
      at(RACE_DATE);
    };
    const logTheRace = async () => {
      await boot();
      fireEvent.click(screen.getByRole("button", { name: "Record a run" }));
      fireEvent.click(screen.getByRole("button", { name: /Enter it manually/ }));
      fireEvent.change(screen.getByLabelText("Distance (km)"), { target: { value: "10" } });
      fireEvent.change(screen.getByLabelText("Duration"), { target: { value: "4800" } });
      fireEvent.click(screen.getByRole("button", { name: "Save run" }));
      // The post-run reward goes first; the prompt never stacks on it.
      expect(screen.queryByText("City 10K 2026, done!")).toBeNull();
      fireEvent.click(await screen.findByRole("button", { name: "Nice" }));
    };

    it("opens once the race run is saved, without a recap or a question, and 'Not now' spends it", async () => {
      seedLive();
      await logTheRace();
      expect(await screen.findByText("City 10K 2026, done!")).toBeInTheDocument();
      expect(track).toHaveBeenCalledWith("whats_next_shown", { variant: "raceFirst" });
      expect(screen.queryByText("How are you feeling about running?")).toBeNull();
      expect(screen.queryByText("The training that got you here")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Not now" }));
      expect(stored().raceBridgeSeen).toBe(true);
      expect(track).toHaveBeenCalledWith("whats_next_answered", { variant: "raceFirst", choice: "later" });
      expect(screen.queryByText("City 10K 2026, done!")).toBeNull();
    });

    it("Keep improving builds a first plan with no race, from the distance just raced", async () => {
      seedLive();
      await logTheRace();
      fireEvent.click(await screen.findByRole("button", { name: /Stay healthy and consistent/ }));
      expect(plan().goal).toMatchObject({ kind: "open", target: "healthy", distanceKm: 10 });
      expect(stored()).toMatchObject({ goalKind: "open", raceBridgeSeen: true, raceDate: "" });
    });
  });

  describe("races folded into a plan with no race", () => {
    it("adding one from the Races tab rebuilds the open plan around it, keeping the blocks", async () => {
      at("2026-09-16");
      const p = buildOpenPlan(settings({ raceDate: "" }) as unknown as SettingsState, { target: "healthy", distanceKm: 10 }, { runs: [] });
      const raceOn = day(15, p.weeks[0].startDate as string);
      store = {
        [STORAGE_KEYS.SETTINGS]: settings({ raceDate: "", goalKind: "open", openTarget: "healthy" }), [STORAGE_KEYS.PLAN]: p, [STORAGE_KEYS.RUNS]: [],
        [STORAGE_KEYS.RACES]: { participations: [{ editionId: "park-10k", label: "Park 10K", raceDate: raceOn, distanceKm: 10, status: "wishlist", timeSec: null, runId: null, notes: "" }], seenBadges: [] },
      };
      await boot();
      fireEvent.click(screen.getByRole("button", { name: "Races" }));
      fireEvent.click(await screen.findByRole("button", { name: /Add to plan/ }));
      const next = plan();
      expect(next.goal).toMatchObject({ kind: "open", target: "healthy" });
      expect(next.raceDate).toBe("");
      expect(next.weeks.flatMap(w => w.sessions).filter(s => s.type === "RACE").map(s => s.date)).toEqual([raceOn]);
    });
  });
});
