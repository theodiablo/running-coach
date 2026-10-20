import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { HrZonesInfoBody } from "./HrZonesInfo";
import { HR_ZONES, hrZoneBpm } from "../utils/hr";
import type { SettingsState } from "../types";

afterEach(cleanup);

describe("HrZonesInfoBody", () => {
  it("works the formula through on the runner's own profile", () => {
    render(<HrZonesInfoBody settings={{ maxHR: 188, restHR: 50 } as SettingsState}/>);
    const z2 = hrZoneBpm(HR_ZONES[1].lo, HR_ZONES[1].hi, 188, 50)!;
    expect(screen.getByText(`On your profile: reserve = 188 − 50 = 138 bpm, so the top of Zone 2 is 50 + 70% × 138 = ${z2.hi} bpm.`)).toBeInTheDocument();
    for (const z of HR_ZONES) {
      const r = hrZoneBpm(z.lo, z.hi, 188, 50)!;
      expect(screen.getByText(`${r.lo}–${r.hi}`)).toBeInTheDocument();
    }
  });

  it("explains the method without numbers when there is no usable profile", () => {
    render(<HrZonesInfoBody/>);
    expect(screen.getByText(/Add your max and resting heart rate/)).toBeInTheDocument();
    expect(screen.getByText("60–70%")).toBeInTheDocument();
    expect(screen.queryByText(/On your profile/)).toBeNull();
  });
});
