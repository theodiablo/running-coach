// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ reads: [] as ((v: string | null | undefined) => void)[] }));
vi.mock("../publicName", () => ({
  fetchPublicName: vi.fn(() => new Promise<string | null | undefined>(r => { h.reads.push(r); })),
}));

const { usePublicName } = await import("./usePublicName");

beforeEach(() => { h.reads = []; });

describe("usePublicName", () => {
  it("sets the name once the boot read lands", async () => {
    const { result } = renderHook(() => usePublicName("u1"));
    expect(result.current.publicName).toBeUndefined();
    await act(async () => { h.reads[0]("Alex M."); });
    expect(result.current.publicName).toBe("Alex M.");
  });

  it("never lets a late boot read overwrite a save made in the same tick", async () => {
    const { result } = renderHook(() => usePublicName("u1"));
    await act(async () => {
      result.current.setPublicName("Saved");
      h.reads[0]("Old");
      await Promise.resolve();
    });
    expect(result.current.publicName).toBe("Saved");
  });

  it("never lets a failed boot read hide a save", async () => {
    const { result } = renderHook(() => usePublicName("u1"));
    await act(async () => {
      result.current.setPublicName(null);
      h.reads[0](undefined);
      await Promise.resolve();
    });
    expect(result.current.publicName).toBeNull();
  });

  it("retries an unread name on reload, and not once it is read", async () => {
    const { result } = renderHook(() => usePublicName("u1"));
    await act(async () => { h.reads[0](undefined); });
    act(() => result.current.reloadPublicName());
    await waitFor(() => expect(h.reads).toHaveLength(2));
    await act(async () => { h.reads[1]("Alex M."); });
    act(() => result.current.reloadPublicName());
    expect(h.reads).toHaveLength(2);
  });
});
