// Project rules that turn CLAUDE.md conventions into lint errors. Each rule's
// message carries its reason, so the docs only point here.

const DOCS = "see CLAUDE.md";

const unwrap = (node) => {
  let n = node;
  while (n && ["TSAsExpression", "TSNonNullExpression", "ChainExpression", "TSSatisfiesExpression"].includes(n.parent?.type)) n = n.parent;
  return n;
};

const calleeName = (call) =>
  call.callee.type === "Identifier" ? call.callee.name
    : call.callee.type === "MemberExpression" && !call.callee.computed ? call.callee.property.name
      : null;

const IGNORED_COMMENT = /^\s*(eslint-|@vitest-environment|@ts-|global\s|<reference|prettier-ignore)/;

const maxCommentLines = {
  meta: {
    type: "suggestion",
    schema: [{ type: "object", properties: { max: { type: "integer", minimum: 1 } }, additionalProperties: false }],
    messages: {
      tooLong: "Comment block is {{lines}} lines (max {{max}}). Keep the constraint, drop the story: a paragraph belongs in docs/ with a one-line pointer here.",
    },
  },
  create(context) {
    const max = context.options[0]?.max ?? 4;
    const sc = context.sourceCode;
    return {
      Program() {
        const comments = sc.getAllComments().filter((c) => !IGNORED_COMMENT.test(c.value));
        let group = [];
        const flush = () => {
          if (!group.length) return;
          const lines = group.at(-1).loc.end.line - group[0].loc.start.line + 1;
          if (lines > max) context.report({ loc: group[0].loc, messageId: "tooLong", data: { lines, max } });
          group = [];
        };
        for (const c of comments) {
          const before = sc.getTokenBefore(c, { includeComments: false });
          const afterCode = before && before.loc.end.line === c.loc.start.line;
          const prev = group.at(-1);
          if (prev && !afterCode && c.loc.start.line === prev.loc.end.line + 1) group.push(c);
          else { flush(); group.push(c); if (afterCode) flush(); }
        }
        flush();
      },
    };
  },
};

const buildPlanStyle = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      missing: "buildPlan needs an inline opts object with `style:` (settings.planStyle). A missed site silently rebuilds as `balanced`.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "buildPlan") return;
        const opts = node.arguments[5];
        const ok = opts?.type === "ObjectExpression" && opts.properties.some((p) =>
          p.type === "Property" && !p.computed && (p.key.name ?? p.key.value) === "style");
        if (!ok) context.report({ node, messageId: "missing" });
      },
    };
  },
};

const DB_CALLS = new Set(["from", "rpc"]);
const chainHasDbCall = (expr) => {
  let n = expr;
  while (n) {
    if (n.type === "ChainExpression" || n.type === "TSAsExpression" || n.type === "TSNonNullExpression") n = n.expression;
    else if (n.type === "CallExpression") {
      if (n.callee.type === "MemberExpression" && !n.callee.computed && DB_CALLS.has(n.callee.property.name)) return true;
      n = n.callee;
    } else if (n.type === "MemberExpression") n = n.object;
    else return false;
  }
  return false;
};

const supabaseCheckError = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      unchecked: "Destructure and handle `error` too: supabase-js answers a denied or failed query with `{ data: null, error }`, which an unchecked read takes for \"no row\".",
    },
  },
  create(context) {
    return {
      VariableDeclarator(node) {
        if (node.id.type !== "ObjectPattern" || node.init?.type !== "AwaitExpression") return;
        const keys = node.id.properties.filter((p) => p.type === "Property" && !p.computed).map((p) => p.key.name);
        if (!keys.includes("data") || keys.includes("error")) return;
        if (node.id.properties.some((p) => p.type === "RestElement")) return;
        if (chainHasDbCall(node.init.argument)) context.report({ node: node.id, messageId: "unchecked" });
      },
    };
  },
};

const dynamicImportCatch = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      uncaught: "A fire-and-forget import() needs a .catch(): an unhandled chunk-load rejection paints ErrorBoundary's crash overlay over a working app.",
    },
  },
  create(context) {
    return {
      ImportExpression(node) {
        let n = unwrap(node);
        let caught = false;
        while (n.parent?.type === "MemberExpression" && n.parent.object === n && n.parent.parent?.type === "CallExpression") {
          const call = n.parent.parent;
          const name = n.parent.property.name;
          if (name === "catch" || (name === "then" && call.arguments.length >= 2)) caught = true;
          n = unwrap(call);
        }
        let stmt = n.parent;
        if (stmt?.type === "UnaryExpression" && stmt.operator === "void") stmt = stmt.parent;
        if (!caught && stmt?.type === "ExpressionStatement") context.report({ node, messageId: "uncaught" });
      },
    };
  },
};

const modalDismissable = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      missing: "A modal/sheet must call useDismissable in its own component so Android back, Escape and the header's go-Home reset can close it.",
    },
  },
  create(context) {
    let first = null;
    let registered = false;
    return {
      JSXOpeningElement(node) {
        if (!first && node.name.type === "JSXIdentifier" && node.name.name === "ModalOverlay") first = node;
      },
      CallExpression(node) {
        if (calleeName(node) === "useDismissable") registered = true;
      },
      "Program:exit"() {
        if (first && !registered) context.report({ node: first, messageId: "missing" });
      },
    };
  },
};

const noParseOrZeroInOnChange = {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      coalesce: "Don't coalesce to 0 in onChange: keep an emptied number field empty while editing and coalesce at use time.",
    },
  },
  create(context) {
    const PARSERS = new Set(["parseFloat", "parseInt", "Number"]);
    return {
      LogicalExpression(node) {
        if (node.operator !== "||" || node.right.type !== "Literal" || node.right.value !== 0) return;
        if (node.left.type !== "CallExpression" || !PARSERS.has(calleeName(node.left))) return;
        const ancestors = context.sourceCode.getAncestors(node);
        const inOnChange = ancestors.some((a) => a.type === "JSXAttribute" && a.name.name === "onChange");
        const keepsEmpty = ancestors.some((a) => a.type === "ConditionalExpression"
          && a.consequent.type === "Literal" && a.consequent.value === "");
        if (inOnChange && !keepsEmpty) context.report({ node, messageId: "coalesce" });
      },
    };
  },
};

const noSummedHaversine = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      summed: "Never sum haversineM legs: distance has one definition, walkTrack (distanceKm / flattenTrack's cumKm) in src/utils/geo.ts.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (calleeName(node) !== "haversineM") return;
        let n = unwrap(node);
        while (n.parent?.type === "BinaryExpression" && ["/", "*"].includes(n.parent.operator)) n = n.parent;
        const p = n.parent;
        if ((p?.type === "AssignmentExpression" && p.operator === "+=" && p.right === n)
          || (p?.type === "BinaryExpression" && p.operator === "+")) context.report({ node, messageId: "summed" });
      },
    };
  },
};

const hrSamplesThroughExpand = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      raw: "stats.hrSamples is stored compacted: read it through expandHrSamples(...), never raw.",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (node.computed || node.property.name !== "hrSamples") return;
        const obj = node.object;
        const isStats = (obj.type === "Identifier" && obj.name === "stats")
          || (obj.type === "MemberExpression" && !obj.computed && obj.property.name === "stats");
        if (!isStats) return;
        const n = unwrap(node);
        if (n.parent?.type === "AssignmentExpression" && n.parent.left === n) return;
        if (n.parent?.type === "CallExpression" && calleeName(n.parent) === "expandHrSamples" && n.parent.arguments.includes(n)) return;
        context.report({ node, messageId: "raw" });
      },
    };
  },
};

const forbidFile = {
  meta: {
    type: "problem",
    schema: [{ type: "string" }],
    messages: { forbidden: "{{why}}" },
  },
  create(context) {
    return { Program(node) { context.report({ node, loc: { line: 1, column: 0 }, messageId: "forbidden", data: { why: context.options[0] ?? DOCS } }); } };
  },
};

const noEmDashJson = {
  meta: {
    type: "problem",
    language: "json",
    schema: [],
    messages: {
      dash: "No em dashes (—) in French or Spanish copy: it is an English typographic habit. Use a comma, colon, parentheses or a new sentence.",
    },
  },
  create(context) {
    return {
      String(node) {
        if (node.value.includes("—")) context.report({ node, messageId: "dash" });
      },
    };
  },
};

export default {
  meta: { name: "local" },
  rules: {
    "max-comment-lines": maxCommentLines,
    "build-plan-style": buildPlanStyle,
    "supabase-check-error": supabaseCheckError,
    "dynamic-import-catch": dynamicImportCatch,
    "modal-dismissable": modalDismissable,
    "no-parse-or-zero-in-onchange": noParseOrZeroInOnChange,
    "no-summed-haversine": noSummedHaversine,
    "hr-samples-through-expand": hrSamplesThroughExpand,
    "forbid-file": forbidFile,
    "no-em-dash-json": noEmDashJson,
  },
};
