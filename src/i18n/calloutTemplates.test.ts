// @vitest-environment jsdom
import { describe, it, expect, afterAll } from "vitest";
import i18n, { setLocale } from "./index";

// The Android engine fills these templates itself once JS is frozen, so the
// {placeholders} must survive i18next untouched in every locale.
describe("native callout templates", () => {
  afterAll(() => setLocale("en", { persist: false }));

  it.each(["en", "fr", "es"] as const)("%s keeps the placeholders the plugin fills", async (lng) => {
    await setLocale(lng, { persist: false });
    const t = i18n.getFixedT(lng);
    const ph = { pace: "{pace}", target: "{target}", bpm: "{bpm}", km: "{km}" };
    expect(t("tracker.guided.speak.slowBy", ph)).toMatch(/\{pace\}.*\{target\}/);
    expect(t("tracker.guided.speak.hrHigh", ph)).toContain("{bpm}");
    expect(t("tracker.guided.speak.leftKm_other", ph)).toContain("{km}");
    expect(t("tracker.guided.speak.heart", ph)).toBe({ en: "Heart rate {bpm}.", fr: "Cardio {bpm}.", es: "Pulso {bpm}." }[lng]);
    expect(t("tracker.guided.speak.paceShort", { min: "{min}", sec: "{sec}" })).toBe("{min} {sec}");
    for (const k of ["leftM_one", "leftM_other", "leftSec_one", "leftSec_other", "leftMin_other"])
      expect(t(`tracker.guided.speak.${k}`, { count: "{n}" })).toContain("{n}");
  });

  // Heard mid-run, a sentence that opens on a bare number reads as distance done.
  it.each(["en", "fr", "es"] as const)("%s says what's left before the number, and marks distance done", async (lng) => {
    await setLocale(lng, { persist: false });
    const t = i18n.getFixedT(lng);
    const ph = { km: "{km}" };
    for (const k of ["leftKm_one", "leftKm_other"]) expect(t(`tracker.guided.speak.${k}`, ph)).not.toMatch(/^\{km\}/);
    for (const k of ["leftM_other", "leftSec_other", "leftMin_other"])
      expect(t(`tracker.guided.speak.${k}`, { count: "{n}" })).not.toMatch(/^\{n\}/);
    const done = t("tracker.guided.speak.distDone_other", ph);
    expect(done).not.toMatch(/^\{km\} \S+\.$/);
  });
});
