import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ShareCardGate } from "./ShareCardGate";
import { dismissTop } from "../utils/backDismiss";
import type { SettingsState } from "../types";

// An import that never settles: the gate stays on its loading fallback.
vi.mock("./ShareCardSheet", () => new Promise(() => {}));

afterEach(cleanup);

describe("ShareCardGate", () => {
  it("lets back / Escape close the builder while it is still loading, and only the builder", () => {
    const onClose = vi.fn();
    render(<ShareCardGate run={{ date: "2026-11-20", km: 5, durationSec: 1800 }} runs={[]} plan={null}
      settings={{} as SettingsState} participations={[]} points={null} onClose={onClose} />);
    expect(dismissTop()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
