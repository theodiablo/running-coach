// admin-metrics, pure half: who may read the metrics, what the coach cost, and
// the weekly digest's text. Plain ESM so Vitest covers it
// (src/utils/adminMetrics.test.ts). docs/product-metrics.md.

import { jwtClaims } from "./appleAuth.mjs";

// USD per million tokens, Anthropic list price. Ignores prompt caching, so the
// figure is an estimate; a model missing here is reported as unpriced, never
// guessed.
export const MODEL_PRICES = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export function estimateCost(byModel) {
  let usd = 0;
  const unpriced = [];
  for (const [model, t] of Object.entries(byModel ?? {})) {
    const price = MODEL_PRICES[model];
    if (!price) {
      unpriced.push(model);
      continue;
    }
    usd += ((t.input ?? 0) * price.input + (t.output ?? 0) * price.output) / 1e6;
  }
  return { usd, unpriced: unpriced.sort() };
}

// Constant-time over the longer input, so neither content nor length leaks.
export function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a ?? ""));
  const y = new TextEncoder().encode(String(b ?? ""));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0 && x.length > 0;
}

// `jwt` must already be verified (auth.getUser succeeded on it): this only
// reads its claims. A password alone is not enough to read company metrics.
export function isAdminCaller({ userId, jwt }, adminUserId) {
  if (!adminUserId || userId !== adminUserId) return false;
  return jwtClaims(jwt)?.aal === "aal2";
}

const usd = (n) => `$${n.toFixed(2)}`;
const prev = (n) => `(prev ${n})`;
const tally = (obj) =>
  Object.entries(obj ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ${n}`)
    .join(", ") || "none";
const row = (label, value) => `  ${label.padEnd(18)}${value}`;

// Says which windows an unpriced model touched, so past usage doesn't read as current.
function unpricedNote(tokens, model) {
  const scope = tokens?.["7d"]?.[model] ? "incl. this week" : tokens?.["30d"]?.[model] ? "last 30 days" : "all time only";
  return `${model}, ${tokens?.all?.[model]?.rounds ?? 0} turns, ${scope}`;
}

export function formatDigest(m) {
  const day = String(m.generated_at).slice(0, 10);
  const cost = Object.fromEntries(
    ["7d", "30d", "all"].map((w) => [w, estimateCost(m.coach.tokens?.[w])]),
  );
  const unpriced = [...new Set(Object.values(cost).flatMap((c) => c.unpriced))].sort();

  const lines = [
    `Running Coach - weekly metrics (${day})`,
    "",
    "Users",
    row("Total", m.users.total),
    row("New this week", `${m.users.new_7d} ${prev(m.users.new_prev7d)}`),
    row("New, 30 days", m.users.new_30d),
    row("Onboarded", m.users.onboarded),
    row("Premium", m.users.premium),
    "",
    "Active accounts (saved data)",
    row("This week", `${m.active["7d"]} ${prev(m.active.prev7d)}`),
    row("30 days", m.active["30d"]),
    "",
    "Runs (by run date)",
    row("This week", `${m.runs["7d"]} by ${m.runs.runners_7d} runners ${prev(m.runs.prev7d)}`),
    row("GPS-recorded", m.runs.gps_7d),
    row("Cross-training", m.runs.cross_training_7d),
    row("Distance", `${m.runs.km_7d} km`),
    row("All time", m.runs.total),
    "",
    "Plans",
    row("Total", `${m.plans.total} (${m.plans.upcoming_race} with a race ahead)`),
    row("By style", tally(m.plans.by_style)),
    "",
    "AI coach",
    row(
      "This week",
      `${m.coach.conversations_7d} conversations by ${m.coach.users_7d} users ${prev(m.coach.conversations_prev7d)}, ${m.coach.accepted_7d} accepted`,
    ),
    row("All time", `${m.coach.conversations_total} conversations`),
    row("Est. spend", `${usd(cost["7d"].usd)} this week, ${usd(cost["30d"].usd)} / 30 days, ${usd(cost.all.usd)} all time`),
    ...unpriced.map((model) => row("Not in spend", unpricedNote(m.coach.tokens, model))),
    "",
    "Feedback",
    row("Beta feedback", `${m.feedback.beta_7d} this week (${m.feedback.beta_total} total)`),
    row("Coach flags", `${m.feedback.coach_flags_7d} this week (${m.feedback.coach_flags_total} total)`),
    "",
    row("Integrations", tally(m.integrations)),
  ];
  return { subject: `Running Coach - weekly metrics (${day})`, text: lines.join("\n") + "\n" };
}
