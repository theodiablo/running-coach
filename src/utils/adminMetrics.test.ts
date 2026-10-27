import { describe, it, expect } from "vitest";
// @ts-expect-error — plain ESM module shared with the admin-metrics edge function.
import { estimateCost, formatDigest, isAdminCaller, safeEqual } from "../../supabase/functions/_shared/adminMetrics.mjs";

const b64url = (obj: unknown) =>
  btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: "ES256" })}.${b64url(claims)}.sig`;

const ADMIN = "11111111-1111-1111-1111-111111111111";

const METRICS = {
  generated_at: "2026-10-19T06:20:00+00:00",
  users: { total: 62, new_7d: 2, new_prev7d: 11, new_30d: 25, onboarded: 50, premium: 1 },
  active: { "7d": 6, prev7d: 9, "30d": 31 },
  runs: { total: 264, "7d": 9, prev7d: 14, runners_7d: 4, gps_7d: 5, cross_training_7d: 0, km_7d: 63.7 },
  plans: { total: 43, upcoming_race: 32, by_style: { balanced: 14, lowfreq: 12, hansons: 2 } },
  coach: {
    conversations_total: 70,
    conversations_7d: 7,
    conversations_prev7d: 11,
    users_7d: 2,
    accepted_7d: 5,
    tokens: {
      "7d": { "claude-sonnet-5-5": { rounds: 12, input: 1_000_000, output: 100_000 } },
      "30d": {},
      all: {
        "claude-sonnet-5-5": { rounds: 12, input: 1_000_000, output: 100_000 },
        "mistral-large-latest": { rounds: 15, input: 172_120, output: 6_535 },
      },
    },
  },
  feedback: { beta_7d: 0, beta_total: 0, coach_flags_7d: 1, coach_flags_total: 2 },
  integrations: { suunto: 2, polar: 1 },
};

describe("estimateCost", () => {
  it("prices known models at list price and names the rest instead of guessing", () => {
    expect(estimateCost(METRICS.coach.tokens.all)).toEqual({ usd: 3, unpriced: ["mistral-large-latest"] });
  });

  it("is zero for no usage", () => {
    expect(estimateCost({})).toEqual({ usd: 0, unpriced: [] });
    expect(estimateCost(undefined)).toEqual({ usd: 0, unpriced: [] });
  });
});

describe("safeEqual", () => {
  it("matches only the exact secret", () => {
    expect(safeEqual("s3cret-value", "s3cret-value")).toBe(true);
    expect(safeEqual("s3cret-valuf", "s3cret-value")).toBe(false);
    expect(safeEqual("s3cret", "s3cret-value")).toBe(false);
    expect(safeEqual(null, "s3cret-value")).toBe(false);
  });

  it("never matches an empty secret, so an unset env var can't open the door", () => {
    expect(safeEqual("", "")).toBe(false);
  });
});

describe("isAdminCaller", () => {
  it("admits the admin's MFA-verified session", () => {
    expect(isAdminCaller({ userId: ADMIN, jwt: jwt({ sub: ADMIN, aal: "aal2" }) }, ADMIN)).toBe(true);
  });

  it("refuses the admin on a password-only session", () => {
    expect(isAdminCaller({ userId: ADMIN, jwt: jwt({ sub: ADMIN, aal: "aal1" }) }, ADMIN)).toBe(false);
  });

  it("refuses any other user, and everyone when no admin is configured", () => {
    const other = "22222222-2222-2222-2222-222222222222";
    expect(isAdminCaller({ userId: other, jwt: jwt({ sub: other, aal: "aal2" }) }, ADMIN)).toBe(false);
    expect(isAdminCaller({ userId: ADMIN, jwt: jwt({ sub: ADMIN, aal: "aal2" }) }, "")).toBe(false);
    expect(isAdminCaller({ userId: undefined, jwt: "garbage" }, ADMIN)).toBe(false);
  });
});

describe("formatDigest", () => {
  const { subject, text } = formatDigest(METRICS);

  it("dates the subject from the snapshot", () => {
    expect(subject).toBe("Running Coach - weekly metrics (2026-10-19)");
  });

  it("shows week-over-week figures, spend, and unpriced models", () => {
    expect(text).toContain("New this week     2 (prev 11)");
    expect(text).toContain("This week         9 by 4 runners (prev 14)");
    expect(text).toContain("$3.00 this week, $0.00 / 30 days, $3.00 all time");
    expect(text).toContain("Not in spend      mistral-large-latest, 15 turns, all time only");
    expect(text).toContain("By style          balanced 14, lowfreq 12, hansons 2");
    expect(text).toContain("Integrations      suunto 2, polar 1");
  });

  it("flags an unpriced model used this week as current", () => {
    const mistral = { rounds: 2, input: 10, output: 10 };
    const tokens = { "7d": { "mistral-large-latest": mistral }, "30d": { "mistral-large-latest": mistral }, all: { "mistral-large-latest": mistral } };
    const { text } = formatDigest({ ...METRICS, coach: { ...METRICS.coach, tokens } });
    expect(text).toContain("Not in spend      mistral-large-latest, 2 turns, incl. this week");
  });

  it("says none rather than leaving a tally blank", () => {
    expect(formatDigest({ ...METRICS, integrations: {} }).text).toContain("Integrations      none");
  });
});
