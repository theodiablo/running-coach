import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { HistoryView } from "./HistoryView";
import type { Run } from "../types";

const run = (date: string, km: number): Run =>
  ({ id: date, date, type: "EASY", km, durationSec: km * 330 } as unknown as Run);

const section = (heading: string) => screen.getByText(heading).parentElement!.parentElement as HTMLElement;
const view = (runs: Run[]) => render(<HistoryView runs={runs} deleteRun={() => {}} updateRun={() => {}}/>);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09T09:00:00")); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("HistoryView week grouping", () => {
  it("groups runs into Mon-Sun weeks, not months", () => {
    view([run("2026-10-08", 8), run("2026-10-06", 9), run("2026-10-04", 9.5), run("2026-10-01", 6), run("2026-09-28", 5.5), run("2026-09-20", 10)]);
    const ids = (heading: string) => Array.from(section(heading).querySelectorAll("[id^='run-']")).map(e => e.id.slice(4));
    expect(ids("This week")).toEqual(["2026-10-08", "2026-10-06"]);
    expect(ids("Last week")).toEqual(["2026-10-04", "2026-10-01", "2026-09-28"]);
    expect(section("This week")).toHaveTextContent("17.0 km");
    expect(section("Last week")).toHaveTextContent("21.0 km");
    expect(ids("14 Sept – 20 Sept")).toEqual(["2026-09-20"]);
  });

  it("names the year on a week from another year", () => {
    view([run("2025-12-30", 5)]);
    expect(screen.getByText("29 Dec – 4 Jan 2026")).toBeInTheDocument();
  });
});
