import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import RunningCoach from "./RunningCoach";
import { STORAGE_KEYS } from "./constants";

// The blob the hub reads at boot. Tests seed it per-case; the db module is
// mocked so mounting never touches Supabase.
let store: Record<string, unknown> = {};

vi.mock("./db", () => ({
  db: {
    get: async (k: string) => store[k] ?? null,
    set: (k: string, v: unknown) => { store[k] = v; },
  },
  currentUserId: () => "test-user",
  flushNow: async () => {},
}));

const SETTINGS = { name: "Ada", onboarded: true, raceDate: "2026-10-04", distanceKm: 21.1 };
const PLAN = {
  raceDate: "2026-10-04",
  distanceKm: 21.1,
  goalSec: 6300,
  weeks: [{ weekNumber: 1, startDate: "2026-07-20", phase: "BASE", sessions: [] }],
};

describe("RunningCoach (smoke)", () => {
  beforeEach(() => { store = {}; });

  it("mounts and reaches first-run onboarding without crashing", async () => {
    render(<RunningCoach onSignOut={() => {}} />);
    // With an empty store the app finishes loading and opens onboarding on the
    // first (Welcome / name) step.
    expect(await screen.findByText(/Welcome to Running Coach/i)).toBeInTheDocument();
  });

  // The coach button lives in the app header (not the Plan tab) so it's reachable
  // from every view — but the chat itself is gated on a plan existing, so the
  // button must be too or it opens an empty overlay.
  it("shows the header coach button once a plan exists", async () => {
    store = { [STORAGE_KEYS.SETTINGS]: SETTINGS, [STORAGE_KEYS.PLAN]: PLAN };
    render(<RunningCoach onSignOut={() => {}} />);
    expect(await screen.findByRole("button", { name: "Coach" })).toBeInTheDocument();
  });

  it("hides the header coach button when there is no plan", async () => {
    store = { [STORAGE_KEYS.SETTINGS]: SETTINGS };
    render(<RunningCoach onSignOut={() => {}} />);
    // Settings is the header's other control — wait for it so we assert on a
    // booted header rather than on a still-loading splash.
    expect(await screen.findByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Coach" })).not.toBeInTheDocument();
  });

  // With no router the header brand mark is the only "go Home from anywhere"
  // affordance, so it has to work from a tab the bottom nav put you on.
  it("tapping the brand mark returns to Home from another tab", async () => {
    store = { [STORAGE_KEYS.SETTINGS]: SETTINGS, [STORAGE_KEYS.PLAN]: PLAN };
    render(<RunningCoach onSignOut={() => {}} />);
    expect(await screen.findByText(/Ada/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(screen.queryByText(/Ada/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Running Coach" }));
    expect(screen.getByText(/Ada/)).toBeInTheDocument();
  });

  // The coachmark's dimmer sits below the bottom nav on purpose (so the Coach
  // pill it points at stays tappable), which means a tab tap unmounts it
  // without running any of its dismiss controls. Leaving Home has to spend the
  // flag anyway, or the pointer returns on every later Home visit and launch.
  it("spends the coachmark when a nav tab takes the user off Home", async () => {
    store = {
      [STORAGE_KEYS.SETTINGS]: { ...SETTINGS, coachIntroSeen: false },
      [STORAGE_KEYS.PLAN]: PLAN,
    };
    render(<RunningCoach onSignOut={() => {}} />);
    expect(await screen.findByRole("dialog", { name: /coach/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Running Coach" }));

    expect(await screen.findByText(/Ada/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /coach/i })).not.toBeInTheDocument();
    expect((store[STORAGE_KEYS.SETTINGS] as { coachIntroSeen?: boolean }).coachIntroSeen).toBe(true);
  });
});
