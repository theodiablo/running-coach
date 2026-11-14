import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ReadinessChecklist } from "./ReadinessChecklist";
import { BG_LOC_DISCLOSED_KEY } from "../constants";
import en from "../i18n/locales/en/login.json";

const ACCEPT = en.bgLocation.allowContinue;
const fixReadiness = vi.fn<(id: string) => Promise<void>>(async () => {});
vi.mock("../geo/readiness", async (orig) => ({
  ...(await orig<typeof import("../geo/readiness")>()),
  checkReadiness: async () => ({ location: true, background: false, battery: false }),
  fixReadiness: (id: string) => fixReadiness(id),
}));

afterEach(cleanup);
beforeEach(() => { fixReadiness.mockClear(); localStorage.clear(); });

const allowBackground = async () => {
  await screen.findByText("Location with the screen off");
  // Rows in order: background ("Allow"), battery ("Open settings").
  fireEvent.click(screen.getByText("Allow"));
};

describe("ReadinessChecklist", () => {
  // Location already granted elsewhere (a "Near me" search) must not open a way
  // to "Allow all the time" past the Play disclosure.
  it("shows the disclosure before asking for background location", async () => {
    render(<ReadinessChecklist/>);
    await allowBackground();
    expect(fixReadiness).not.toHaveBeenCalled();
    expect(screen.getByText("Background location")).toBeInTheDocument();
    fireEvent.click(screen.getByText(ACCEPT));
    await waitFor(() => expect(fixReadiness).toHaveBeenCalledWith("background"));
  });

  it("asks straight away once this install accepted the disclosure", async () => {
    localStorage.setItem(BG_LOC_DISCLOSED_KEY, "1");
    render(<ReadinessChecklist/>);
    await allowBackground();
    await waitFor(() => expect(fixReadiness).toHaveBeenCalledWith("background"));
  });

  it("never gates the battery row on the location disclosure", async () => {
    render(<ReadinessChecklist/>);
    fireEvent.click(await screen.findByText("Open settings"));
    await waitFor(() => expect(fixReadiness).toHaveBeenCalledWith("battery"));
  });
});
