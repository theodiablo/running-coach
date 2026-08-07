import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { ProgressView } from "./ProgressView";
import { setLocale } from "../i18n";
import type { Run, SettingsState } from "../types";

afterEach(async () => { cleanup(); await act(async () => { await setLocale("en", { persist: false }); }); });

const runs = [{ id: "r1", date: "2026-05-01", type: "EASY", km: 6, durationSec: 2100 }] as Run[];

const noop = () => {};

// computeBadges resolves its labels through t() at call time, so a memoised
// caller has to treat the language as a dependency. This is the regression
// guard for that: switching locale with the run/race data untouched must
// re-render the badge copy, not leave the previous language on screen.
describe("Progress badges follow the active locale", () => {
  it("re-renders badge copy after a language switch with unchanged data", async () => {
    render(
      <ProgressView runs={runs} races={null} settings={{} as SettingsState}
        initialSub="badges" navKey={0} deleteRun={noop} updateRun={noop} />,
    );

    expect(await screen.findByText("First 5K")).toBeInTheDocument();

    await act(async () => { await setLocale("fr", { persist: false }); });

    // If the memo ignored the locale the English label would still be on
    // screen, since `runs` and `races` never changed identity.
    expect(screen.queryByText("First 5K")).not.toBeInTheDocument();
    expect(screen.getByText("Premier 5 km")).toBeInTheDocument();
  });
});
