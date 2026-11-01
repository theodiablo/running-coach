import { RuleTester } from "eslint";
import json from "@eslint/json";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import local from "../eslint-rules/index.js";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
});
const rule = (name: string) => local.rules[name];

tester.run("max-comment-lines", rule("max-comment-lines"), {
  valid: [
    { code: "// one\n// two\n// three\n// four\nconst a = 1;", options: [{ max: 4 }] },
    { code: "// one\n// two\n\n// three\n// four\n// five\nconst a = 1;", options: [{ max: 4 }] },
    { code: "const a = 1; // trailing\nconst b = 2; // trailing\nconst c = 3; // trailing\n", options: [{ max: 2 }] },
    { code: "// eslint-disable-next-line no-alert -- reason\n// one\nconst a = 1;", options: [{ max: 1 }] },
  ],
  invalid: [
    { code: "// 1\n// 2\n// 3\n// 4\n// 5\nconst a = 1;", options: [{ max: 4 }], errors: [{ messageId: "tooLong" }] },
    { code: "/*\n * 1\n * 2\n */\nconst a = 1;", options: [{ max: 3 }], errors: [{ messageId: "tooLong" }] },
    { code: "const a = <div>{/* 1\n 2\n 3\n 4\n 5 */}</div>;", options: [{ max: 4 }], errors: [{ messageId: "tooLong" }] },
  ],
});

tester.run("build-plan-style", rule("build-plan-style"), {
  valid: ['buildPlan(d, g, s, k, e, { recentRuns, style: settings.planStyle });'],
  invalid: [
    { code: "buildPlan(d, g, s, k, e, { recentRuns });", errors: [{ messageId: "missing" }] },
    { code: "buildPlan(d, g, s, k, e, opts);", errors: [{ messageId: "missing" }] },
    { code: "buildPlan(d, g, s, k, e);", errors: [{ messageId: "missing" }] },
  ],
});

tester.run("supabase-check-error", rule("supabase-check-error"), {
  valid: [
    'async function f() { const { data, error } = await admin.from("t").select("id"); }',
    "async function f() { const { data } = await userClient.auth.getUser(); }",
    "async function f() { const { data } = await fetchJson(); }",
  ],
  invalid: [
    { code: 'async function f() { const { data } = await admin.from("t").select("id").maybeSingle(); }', errors: [{ messageId: "unchecked" }] },
    { code: 'async function f() { const { data: n } = await admin.rpc("bump", {}); }', errors: [{ messageId: "unchecked" }] },
  ],
});

tester.run("dynamic-import-catch", rule("dynamic-import-catch"), {
  valid: [
    'import("./x").catch(() => {});',
    'import("./x").then(m => m.go(), () => null);',
    'const Lazy = lazy(() => import("./x"));',
    'async function f() { const m = await import("./x"); }',
    'const p = import("./x").then(m => m.a);',
  ],
  invalid: [
    { code: 'import("./x");', errors: [{ messageId: "uncaught" }] },
    { code: 'void import("./x").then(m => m.warm());', errors: [{ messageId: "uncaught" }] },
  ],
});

tester.run("modal-dismissable", rule("modal-dismissable"), {
  valid: ["function S() { useDismissable(true, close); return <ModalOverlay>x</ModalOverlay>; }"],
  invalid: [{ code: "function S() { return <ModalOverlay>x</ModalOverlay>; }", errors: [{ messageId: "missing" }] }],
});

tester.run("no-parse-or-zero-in-onchange", rule("no-parse-or-zero-in-onchange"), {
  valid: [
    '<input onChange={e => setV(e.target.value === "" ? "" : parseInt(e.target.value) || 0)}/>',
    "const km = parseFloat(v) || 0;",
  ],
  invalid: [{ code: "<input onChange={e => setV(parseFloat(e.target.value) || 0)}/>", errors: [{ messageId: "coalesce" }] }],
});

tester.run("no-summed-haversine", rule("no-summed-haversine"), {
  valid: ["const d = haversineM(a, b);", "if (haversineM(a, b) < 5) skip();"],
  invalid: [
    { code: "total += haversineM(a, b);", errors: [{ messageId: "summed" }] },
    { code: "const km = acc + haversineM(a, b) / 1000;", errors: [{ messageId: "summed" }] },
  ],
});

tester.run("hr-samples-through-expand", rule("hr-samples-through-expand"), {
  valid: [
    "const s = expandHrSamples(route?.stats?.hrSamples as HrSample[] | undefined);",
    "route.stats.hrSamples = compact(samples);",
    "const s = buf.hrSamples;",
  ],
  invalid: [{ code: "const s = route.stats.hrSamples;", errors: [{ messageId: "raw" }] }],
});

describe("no-em-dash-json", () => {
  const jsonTester = new RuleTester({ plugins: { json }, language: "json/json" });
  jsonTester.run("no-em-dash-json", rule("no-em-dash-json"), {
    valid: ['{"a": "Bonjour, ça va ?"}'],
    invalid: [{ code: '{"a": "Bonjour — ça va ?"}', errors: [{ messageId: "dash" }] }],
  });
});

describe("eslint.config.js seam rules", () => {
  const lint = async (filePath: string, code: string) => {
    const { ESLint } = await import("eslint");
    const [res] = await new ESLint({ cwd: process.cwd() }).lintText(code, { filePath });
    return res.messages.map((m) => m.ruleId);
  };
  it.each([
    ["src/views/X.tsx", "navigator.geolocation.getCurrentPosition(() => {});", "seams/gps-through-geo-source"],
    ["src/views/X.tsx", "L.tileLayer(url);", "seams/tiles-through-cache"],
    ["src/views/X.tsx", 'import posthog from "posthog-js"; posthog.init();', "seams/telemetry-sdk"],
    ["src/views/X.tsx", 'import { Geolocation } from "@capacitor/geolocation"; Geolocation.x();', "seams/no-native-in-ui"],
    ["src/utils/x.ts", 'import { KeepAwake } from "@capacitor-community/keep-awake"; KeepAwake.x();', "seams/keep-awake-hook"],
    ["src/utils/x.ts", 'import { motion } from "framer-motion"; motion();', "seams/css-only-animations"],
    ["src/utils/x.ts", "export const g = (plan: { goalSec: number }) => plan.goalSec;", "seams/goal-from-settings"],
    ["src/utils/x.ts", "export const e = (r: { bestEfforts: unknown }) => r.bestEfforts;", "seams/best-efforts-through-helpers"],
    ["src/utils/x.ts", "export const re = /(?<=a)b/;", "seams/no-regex-lookbehind"],
    ["src/utils/x.ts", "export const d = new Date().toISOString().slice(0, 10);", "seams/no-iso-date-slice"],
    ["src/utils/x.js", "export const a = 1;", "local/forbid-file"],
    ["supabase/functions/x/index.ts", 'import { serve } from "https://deno.land/std/http/server.ts"; serve();', "seams/npm-specifiers"],
  ])("%s: %s -> %s", async (file, code, rule) => {
    expect(await lint(file, code)).toContain(rule);
  });
  it("leaves the seam's own file alone", async () => {
    expect(await lint("src/geo/web.ts", "navigator.geolocation.clearWatch(1);")).not.toContain("seams/gps-through-geo-source");
    expect(await lint("src/views/X.tsx", 'import { Browser } from "@capacitor/browser"; Browser.open({ url: "" });')).not.toContain("seams/no-native-in-ui");
    expect(await lint("src/views/X.tsx", 'import { x } from "./capacitorish"; x();')).not.toContain("seams/no-native-in-ui");
    expect(await lint("src/views/X.tsx", 'import { H } from "@pianissimoproject/capacitor-health-connect"; H.x();')).toContain("seams/no-native-in-ui");
  });
});
