import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

vi.mock("../hr/ble", () => ({
  bleSource: {
    scan: vi.fn(async (onFound: (d: { id: string; name: string }) => void) => { onFound({ id: "d1", name: "HRM-Pro" }); }),
    requestPermissions: vi.fn(async () => true),
  },
}));

import { bleSource } from "../hr/ble";
import { useBlePairing } from "./useBlePairing";
import { getPairedDevice } from "../hr/device";

afterEach(() => { localStorage.clear(); vi.clearAllMocks(); });

// The pairing flow is shared by the Connections card and the onboarding heart-
// rate step, so the disclosure gate (a Play requirement) is tested once here
// rather than trusted to each caller.
describe("useBlePairing", () => {
  it("raises the disclosure before the first scan, and scans once accepted", async () => {
    const { result } = renderHook(() => useBlePairing({}));
    act(() => { result.current.startScan(); });
    expect(result.current.showDisclosure).toBe(true);
    expect(bleSource.scan).not.toHaveBeenCalled();

    await act(async () => { await result.current.acceptDisclosure(); });
    expect(bleSource.scan).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.found).toHaveLength(1));
  });

  it("skips the disclosure once it has been accepted on this device", async () => {
    const { result } = renderHook(() => useBlePairing({}));
    await act(async () => { await result.current.acceptDisclosure(); });
    act(() => { result.current.startScan(); });
    expect(result.current.showDisclosure).toBe(false);
    await waitFor(() => expect(bleSource.scan).toHaveBeenCalledTimes(2));
  });

  it("does not mark the device disclosed when Bluetooth permission is refused", async () => {
    (bleSource.requestPermissions as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const showToast = vi.fn();
    const { result } = renderHook(() => useBlePairing({ showToast }));
    await act(async () => { await result.current.acceptDisclosure(); });
    expect(bleSource.scan).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.any(String), "err");

    act(() => { result.current.startScan(); });
    expect(result.current.showDisclosure).toBe(true);
  });

  it("persists the chosen device and reports it to the caller", async () => {
    const onPaired = vi.fn();
    const { result } = renderHook(() => useBlePairing({ onPaired }));
    await act(async () => { await result.current.acceptDisclosure(); });
    await waitFor(() => expect(result.current.found).toHaveLength(1));

    act(() => { result.current.choose({ id: "d1", name: "HRM-Pro" }); });
    expect(getPairedDevice()).toEqual({ id: "d1", name: "HRM-Pro" });
    expect(onPaired).toHaveBeenCalledWith({ id: "d1", name: "HRM-Pro" });
    expect(result.current.found).toHaveLength(0);
  });
});
