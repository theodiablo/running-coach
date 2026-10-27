import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { OnboardingWizard } from "./OnboardingWizard";
import { LIVE_SHARE_KEY } from "../constants";
import type { SettingsState } from "../types";

const TOKEN = "A".repeat(22);
const ensureShareLink = vi.fn(() => Promise.resolve<string | null>(TOKEN));
vi.mock("../live/shareLinkStore", () => ({
  readCachedShareLink: () => null,
  fetchShareLink: () => Promise.resolve(null),
  ensureShareLink: () => ensureShareLink(),
  rotateShareLink: () => Promise.resolve({ token: null }),
}));

afterEach(cleanup);
beforeEach(() => {
  ensureShareLink.mockClear();
  localStorage.clear();
});

const setup = (settings: Partial<SettingsState> = {}) => {
  const onComplete = vi.fn();
  const onSaveProgress = vi.fn();
  render(<OnboardingWizard settings={{ onboardStep: 0, intent: null, ...settings } as SettingsState}
    onSaveProgress={onSaveProgress} onComplete={onComplete} catalogue={[]}
    addRace={vi.fn()} addEdition={vi.fn()} refreshCatalogue={vi.fn()} showToast={vi.fn()}/>);
  return { onComplete, onSaveProgress };
};

const passHealthGate = () => {
  fireEvent.click(screen.getByText("No, none apply"));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByText("Continue"));
};

describe("OnboardingWizard: live sharing", () => {
  it("advertises live sharing on the welcome screen", () => {
    setup();
    expect(screen.getByText(/Share a run live/)).toBeInTheDocument();
  });

  it("offers following a race as a third reason to be here", () => {
    setup({ onboardStep: 1 });
    expect(screen.getByText("Let people follow my race")).toBeInTheDocument();
    expect(screen.getByText("I'm training for a race")).toBeInTheDocument();
  });

  it("completes without a plan, with the share switch armed on this device", async () => {
    const { onComplete } = setup({ onboardStep: 1 });
    fireEvent.click(screen.getByText("Let people follow my race"));
    expect(screen.getByText("Which race?")).toBeInTheDocument();
    // A participation is keyed by its catalogue edition, so there is no free-text race.
    expect(screen.queryByText("Just enter it for myself →")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("No race in mind, just a run →"));

    // Web: no device-readiness step, straight to the link.
    expect(screen.getByText("Your follow link")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Create your link"));
    // This screen is the explanation, so creating needs no confirm.
    expect(screen.queryByText("Create your sharing link?")).not.toBeInTheDocument();
    await waitFor(() => expect(ensureShareLink).toHaveBeenCalledTimes(1));
    await screen.findByText(new RegExp(`watch/${TOKEN}`));
    fireEvent.click(screen.getByText("Continue"));

    // The health gate is the live branch's last step: there is no plan to summarise.
    expect(screen.getByText("One last thing")).toBeInTheDocument();
    passHealthGate();

    expect(onComplete).toHaveBeenCalledTimes(1);
    const payload = onComplete.mock.calls[0][0];
    expect(payload.plan).toBeNull();
    expect(payload.live).toEqual({ editionId: null, linkSent: false });
    expect(payload.healthAck.at).toBeTruthy();
    expect(localStorage.getItem(LIVE_SHARE_KEY)).toBe("1");
  });

  it("leaves sharing off when the runner switches it off", () => {
    const { onComplete } = setup({ onboardStep: 1 });
    fireEvent.click(screen.getByText("Let people follow my race"));
    fireEvent.click(screen.getByText("No race in mind, just a run →"));
    fireEvent.click(screen.getByRole("switch", { name: "Share my runs from this phone" }));
    fireEvent.click(screen.getByText("Continue"));
    passHealthGate();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(LIVE_SHARE_KEY)).toBe("0");
  });

  it("keeps the plan branches ending on the summary", () => {
    const { onComplete } = setup({ onboardStep: 1 });
    fireEvent.click(screen.getByText("I'm just getting started"));
    fireEvent.click(screen.getByText("Skip"));
    passHealthGate();
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByText("You're all set!")).toBeInTheDocument();
  });
});
