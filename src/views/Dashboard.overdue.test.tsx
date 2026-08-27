import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import { Dashboard } from "./Dashboard";
import { track } from "../telemetry";
import type { Plan, SettingsState } from "../types";

afterEach(cleanup);

// Fixed "now" so the fixture dates keep their past/future meaning forever.
const NOW = new Date("2026-03-10T09:00:00");
vi.mock("../telemetry", () => ({ track: vi.fn() }));

vi.useFakeTimers({ shouldAdvanceTime: true });
vi.setSystemTime(NOW);

const sess = (id: string, date: string, extra: Record<string, unknown> = {}) =>
  ({id, date, type: "EASY", desc: "Easy run 5km", km: 5, pace: 360, ...extra});

const planOf = (sessions: ReturnType<typeof sess>[]) =>
  ({weeks: [{weekNumber: 1, startDate: "2026-03-02", phase: "base", sessions}]} as unknown as Plan);

const settings = {raceDate: "", distanceKm: "", goalSec: ""} as unknown as SettingsState;

const renderDash = (plan: Plan | null, over: Record<string, unknown> = {}) => {
  const props = {
    runs: [], plan, settings, races: null,
    goTab: vi.fn(), goProgress: vi.fn(), goLog: vi.fn(),
    toggleSess: vi.fn(), skipSess: vi.fn(),
    openSettings: vi.fn(), openCoach: vi.fn(), showToast: vi.fn(),
    ...over,
  };
  render(<Dashboard {...(props as unknown as React.ComponentProps<typeof Dashboard>)} />);
  return props;
};

describe("Dashboard overdue card", () => {
  it("surfaces sessions the runner never got to, instead of silently skipping them", () => {
    // The regression this whole feature exists for: before it, a session dated
    // in the past simply vanished and the card jumped to the next future one.
    renderDash(planOf([sess("missed", "2026-03-08"), sess("future", "2026-03-12")]));
    expect(screen.getByText("1 session still open")).toBeInTheDocument();
  });

  it("renders nothing when every past session was handled", () => {
    renderDash(planOf([
      sess("a", "2026-03-06", {done: true}),
      sess("b", "2026-03-07", {skipped: true}),
      sess("c", "2026-03-12"),
    ]));
    expect(screen.queryByText(/still open/)).toBeNull();
  });

  it("caps the rows at three and points the rest into the plan", () => {
    const props = renderDash(planOf([
      sess("a", "2026-03-01"), sess("b", "2026-03-02"), sess("c", "2026-03-03"),
      sess("d", "2026-03-04"), sess("e", "2026-03-05"),
    ]));
    expect(screen.getByText("5 sessions still open")).toBeInTheDocument();
    // Three Done buttons = three rendered rows, not five.
    expect(screen.getAllByRole("button", {name: "Done"})).toHaveLength(3);
    fireEvent.click(screen.getByText("2 more in your plan"));
    expect(props.goTab).toHaveBeenCalledWith("plan");
  });

  it("ticks the freshest overdue session with the right week and id", () => {
    const props = renderDash(planOf([sess("older", "2026-03-05"), sess("newer", "2026-03-08")]));
    // Most recent first, so the first row is the freshest miss.
    fireEvent.click(screen.getAllByRole("button", {name: "Done"})[0]);
    expect(props.toggleSess).toHaveBeenCalledWith(1, "newer");
  });

  it("skips an overdue session", () => {
    const props = renderDash(planOf([sess("missed", "2026-03-08")]));
    fireEvent.click(screen.getByRole("button", {name: "Skip"}));
    expect(props.skipSess).toHaveBeenCalledWith(1, "missed");
  });

  it("offers the coach as the forgiving way out", () => {
    const props = renderDash(planOf([sess("missed", "2026-03-08")]));
    fireEvent.click(screen.getByRole("button", {name: /Adjust my plan/}));
    expect(props.openCoach).toHaveBeenCalledWith(null, "dashboard");
  });

  it("keeps showing the next upcoming session alongside the backlog", () => {
    renderDash(planOf([sess("missed", "2026-03-08"), sess("soon", "2026-03-12")]));
    expect(screen.getByText("1 session still open")).toBeInTheDocument();
    expect(screen.getByText("Up next")).toBeInTheDocument();
  });

  it("never lists the upcoming session as overdue", () => {
    renderDash(planOf([sess("today", "2026-03-10")]));
    expect(screen.queryByText(/still open/)).toBeNull();
    expect(screen.getByText("Today's session")).toBeInTheDocument();
  });

  it("reports the backlog once, not on every remount", () => {
    // The last-reported count is module scope (deliberately — it has to survive
    // remounts), so this uses backlog sizes no earlier test in this file has
    // already reported.
    vi.mocked(track).mockClear();
    const shown = () => vi.mocked(track).mock.calls.filter(c => c[0] === "overdue_shown");
    const seven = planOf(["01", "02", "03", "04", "05", "06", "07"].map(d => sess("s" + d, "2026-03-" + d)));

    renderDash(seven);
    expect(shown()).toHaveLength(1);
    expect(shown()[0][1]).toEqual({count: 7});

    // A tab switch or the header brand-mark reset remounts Dashboard; the same
    // backlog must not be counted again.
    cleanup();
    renderDash(seven);
    expect(shown()).toHaveLength(1);

    // A genuine change in the backlog is worth reporting.
    cleanup();
    renderDash(planOf(["01", "02", "03", "04", "05", "06"].map(d => sess("s" + d, "2026-03-" + d))));
    expect(shown()).toHaveLength(2);
    expect(shown()[1][1]).toEqual({count: 6});
  });

  describe("first-backlog coach explainer", () => {
    const INTRO = /Your coach can rebuild what's left/;
    const withFlag = (coachOverdueIntroSeen: boolean | undefined) =>
      ({raceDate: "", distanceKm: "", goalSec: "", coachOverdueIntroSeen} as unknown as SettingsState);

    it("explains what the coach can do the first time a backlog appears", () => {
      // The moment the capability is worth believing: there is now a problem it
      // solves, on a card that already offers it.
      renderDash(planOf([sess("missed", "2026-03-08")]), {settings: withFlag(false)});
      expect(screen.getByText(INTRO)).toBeInTheDocument();
    });

    it("marks itself seen so it never returns", () => {
      const mark = vi.fn();
      renderDash(planOf([sess("missed", "2026-03-08")]), {
        settings: withFlag(false), markCoachOverdueIntroSeen: mark,
      });
      expect(mark).toHaveBeenCalledTimes(1);
    });

    it("stays put for the rest of the visit once shown", () => {
      // Marking it seen writes straight back into the settings blob, which flows
      // back down as a prop. The copy must survive that: the flag governs the
      // NEXT mount, not the one the reader is looking at.
      const plan = planOf([sess("missed", "2026-03-08")]);
      const props = {
        runs: [], plan, races: null, settings: withFlag(false),
        goTab: vi.fn(), goProgress: vi.fn(), goLog: vi.fn(),
        toggleSess: vi.fn(), skipSess: vi.fn(),
        openSettings: vi.fn(), openCoach: vi.fn(), markCoachOverdueIntroSeen: vi.fn(),
      } as unknown as React.ComponentProps<typeof Dashboard>;
      const { rerender } = render(<Dashboard {...props}/>);
      expect(screen.getByText(INTRO)).toBeInTheDocument();

      rerender(<Dashboard {...props} settings={withFlag(true)}/>);
      expect(screen.getByText(INTRO)).toBeInTheDocument();
    });

    it("says nothing once it has been shown", () => {
      renderDash(planOf([sess("missed", "2026-03-08")]), {settings: withFlag(true)});
      expect(screen.queryByText(INTRO)).toBeNull();
    });

    it("never appears for an account that onboarded before it existed", () => {
      // Absent (not false) is the whole install base at ship time: a signpost
      // that surprises a runner mid-training is worse than one they never see.
      renderDash(planOf([sess("missed", "2026-03-08")]), {settings: withFlag(undefined)});
      expect(screen.queryByText(INTRO)).toBeNull();
    });

    it("waits until it is really on screen before spending itself", () => {
      // The card sits below the stat tiles and the next-session card, so a Home
      // visit that never scrolled down would otherwise burn the one-time
      // explainer without it ever being read.
      const observed: Element[] = [];
      let fire: (entries: {isIntersecting: boolean}[]) => void = () => {};
      const disconnect = vi.fn();
      vi.stubGlobal("IntersectionObserver", class {
        constructor(cb: (entries: {isIntersecting: boolean}[]) => void) { fire = cb; }
        observe(el: Element) { observed.push(el); }
        disconnect = disconnect;
        unobserve() {}
        takeRecords() { return []; }
        root = null; rootMargin = ""; thresholds = [];
      });
      try {
        const mark = vi.fn();
        renderDash(planOf([sess("missed", "2026-03-08")]), {
          settings: withFlag(false), markCoachOverdueIntroSeen: mark,
        });
        expect(observed).toHaveLength(1);
        expect(mark).not.toHaveBeenCalled();

        fire([{isIntersecting: false}]);
        expect(mark).not.toHaveBeenCalled();

        fire([{isIntersecting: true}]);
        expect(mark).toHaveBeenCalledTimes(1);

        // Once spent, further intersections must not re-write the blob.
        fire([{isIntersecting: true}]);
        expect(mark).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("does not fire on a plan with nothing overdue", () => {
      const mark = vi.fn();
      renderDash(planOf([sess("future", "2026-03-12")]), {
        settings: withFlag(false), markCoachOverdueIntroSeen: mark,
      });
      expect(mark).not.toHaveBeenCalled();
    });
  });

  it("uses forgiving wording — no shaming, no streak language", () => {
    renderDash(planOf([sess("missed", "2026-03-08")]));
    const card = screen.getByText("1 session still open").closest("div")!.parentElement!.parentElement!;
    expect(within(card).queryByText(/missed|failed|streak|broke/i)).toBeNull();
  });
});
