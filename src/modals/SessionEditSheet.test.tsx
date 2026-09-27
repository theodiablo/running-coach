import { describe, it, expect, vi, afterEach, beforeEach, afterAll } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SessionEditSheet, type SessionEditTarget } from "./SessionEditSheet";
import { buildPlan } from "../utils/plan";
import { fmt, ymd } from "../utils/format";
import { dismissTop } from "../utils/backDismiss";
import type { Plan } from "../types";

const ANCHOR = "2026-09-16";
const dayAfter = (s: string, n: number) => {
  const d = new Date(s + "T00:00:00");
  d.setDate(d.getDate() + n);
  return ymd(d);
};

beforeEach(() => { vi.setSystemTime(new Date(ANCHOR + "T09:00:00")); });
afterEach(cleanup);
afterAll(() => { vi.useRealTimers(); });

const build = (): Plan => buildPlan(dayAfter(ANCHOR, 12 * 7), 6000, [
  { dayOffset: 1, minutes: 45 }, { dayOffset: 3, minutes: 45 }, { dayOffset: 6, minutes: 90 },
], 21.1, 0, { style: "balanced" }) as unknown as Plan;

const setup = (plan: Plan, target: SessionEditTarget) => {
  const h = { onSave: vi.fn(), onAskCoach: vi.fn(), onClose: vi.fn() };
  render(<SessionEditSheet plan={plan} target={target} today={ANCHOR} {...h}/>);
  return h;
};

const dayChip = (date: string) =>
  screen.getAllByRole("button").find(b => b.getAttribute("aria-label")?.endsWith(" " + fmt.sht(date)))!;

describe("SessionEditSheet", () => {
  it("saves nothing until something changes, then hands back the edit", () => {
    const plan = build();
    const w = plan.weeks[1];
    const s = w.sessions.find(x => x.type === "EASY")!;
    const h = setup(plan, { kind: "edit", session: s, weekNumber: w.weekNumber });
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Shorter" }));
    fireEvent.click(save);
    expect(h.onSave).toHaveBeenCalledWith(
      { kind: "update", sessionId: s.id, date: s.date, type: "EASY", km: Math.max(1, Math.round((Number(s.km) - 0.5) * 2) / 2), swapWith: null }, 0);
  });

  it("warns instead of blocking, and offers the coach", () => {
    const plan = build();
    const w = plan.weeks[2];
    // The day before a hard session, inside the week so it's on screen.
    const hard = w.sessions.find(x => ["LONG", "TEMPO", "INTERVALS"].includes(String(x.type)) && dayAfter(x.date, -1) >= w.startDate!)!;
    const before = dayAfter(hard.date, -1);
    const easy = w.sessions.find(x => x.type === "EASY" && x.date !== before)!;
    const h = setup(plan, { kind: "edit", session: easy, weekNumber: w.weekNumber });
    fireEvent.click(dayChip(before));
    fireEvent.click(screen.getByRole("button", { name: "INTERVALS" }));
    expect(screen.getByText("Heads-up")).toBeInTheDocument();
    expect(screen.getByText(/back to back/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save anyway" }));
    expect(h.onSave).toHaveBeenCalledTimes(1);
    expect(h.onSave.mock.calls[0][1]).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Ask the coach" }));
    expect(h.onAskCoach).toHaveBeenCalledTimes(1);
  });

  it("offers to swap with the session already on the picked day", () => {
    const plan = build();
    const w = plan.weeks[1];
    const [a, b] = w.sessions;
    const h = setup(plan, { kind: "edit", session: a, weekNumber: w.weekNumber });
    fireEvent.click(dayChip(b.date));
    expect(screen.getByRole("checkbox")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    expect(h.onSave.mock.calls[0][0]).toMatchObject({ date: b.date, swapWith: b.id });
  });

  it("confirms a delete in the sheet before handing it back", () => {
    const plan = build();
    const w = plan.weeks[1];
    const s = w.sessions[0];
    const h = setup(plan, { kind: "edit", session: s, weekNumber: w.weekNumber });
    fireEvent.click(screen.getByRole("button", { name: "Delete this session" }));
    expect(h.onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(h.onSave).toHaveBeenCalledWith({ kind: "delete", sessionId: s.id }, 0);
  });

  it("adds a session on the offered day", () => {
    const plan = build();
    const w = plan.weeks[1];
    const busy = new Set(w.sessions.map(s => s.date));
    const day = Array.from({ length: 7 }, (_, i) => dayAfter(w.startDate!, i)).find(d => !busy.has(d))!;
    const h = setup(plan, { kind: "add", weekNumber: w.weekNumber, date: day });
    fireEvent.click(screen.getByRole("button", { name: "WALK" }));
    fireEvent.click(screen.getByRole("button", { name: /^(Add|Save anyway)$/ }));
    expect(h.onSave.mock.calls[0][0]).toMatchObject({ kind: "add", date: day, type: "WALK" });
  });

  it("closes on Android back / Escape via the dismiss registry", () => {
    const plan = build();
    const h = setup(plan, { kind: "edit", session: plan.weeks[1].sessions[0], weekNumber: plan.weeks[1].weekNumber });
    expect(dismissTop()).toBe(true);
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });
});
