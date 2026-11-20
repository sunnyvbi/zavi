
export type OperatorFailureShape =
  | "capability-denial"
  | "completeness-overclaim"
  | "metric-mislabel"
  | "dead-end-punt"
  | "shallow-review";

export const OPERATOR_FAILURE_SHAPES: readonly OperatorFailureShape[] = [
  "capability-denial",
  "completeness-overclaim",
  "metric-mislabel",
  "dead-end-punt",
  "shallow-review",
] as const;

export type FailureShapeInput = {
  output_text: string | null | undefined;
  classify_tier?: "tier1" | "tier2" | "tier3" | null;
  tool_calls?: ReadonlyArray<{ name?: string; status?: string }>;
  question?: string | null;
};

function ranAnyReadTool(calls: FailureShapeInput["tool_calls"]): boolean {
  if (!calls) return false;
  return calls.some(
    (c) =>
      c.status === "ok" &&
      typeof c.name === "string" &&
      /^(memory__|operator_db__|github__|web_fetch__|stripe__|slack__|apify__)/.test(
        c.name,
      ),
  );
}

function ranHandoff(calls: FailureShapeInput["tool_calls"]): boolean {
  if (!calls) return false;
  return calls.some(
    (c) =>
      typeof c.name === "string" &&
      /^praxis__(handoff|ask_agent)/.test(c.name) &&
      (c.status === "ok" || c.status === "denied" || c.status === "error"),
  );
}

const LOOKUP_RE =
  /\b(pricing|price|fee|fees|plan tiers?|how (?:much|does)|what(?:'s| is) (?:our|the)|payout|cancellation|protection plan|insurance plan|commission|rate)\b/i;

const COMPLETENESS_RE =
  /\b(here'?s everything|that'?s (?:all|everything)|the (?:full|complete|entire) (?:list|set|picture)|all of (?:them|it|the)|nothing else|that covers (?:it|everything)|exhaustive|comprehensive list)\b/i;

const DENIAL_RE =
  /\b(i (?:can'?t|cannot|don'?t have access|am not able|do not have (?:access|the ability))|that'?s not something i can|i'?m not able to|unable to (?:access|do|help)|outside (?:my|what i can))\b/i;

const CONFUSABLE_METRIC_PAIRS: ReadonlyArray<[RegExp, RegExp]> = [
  [/\bgmv\b/i, /\b(revenue|take[- ]?rate|net revenue)\b/i],
  [/\bspend\b/i, /\bbudget\b/i],
  [/\bmrr\b/i, /\b(arr|annual recurring)\b/i],
  [/\bgross\b/i, /\bnet\b/i],
];
const HAS_NUMERIC = /(\$\s?\d|\d+(?:\.\d+)?\s?%|\b\d{2,}\b)/;

const REVIEW_ASK_RE =
  /\b(review|critique|feedback on (?:this|the|my)|what do you think of|thoughts on (?:this|the|my)|take a look at (?:this|the|my)|proofread|any (?:gaps|issues|problems)|tear (?:this|it) apart|red[- ]?team (?:this|it))\b/i;

const REVIEW_REMAINDER_HEDGE_RE =
  /\b(?:the rest|everything else|the remainder|all else)\b[^.!?\n]{0,40}\b(?:is|are|looks?|reads?|seems?)\b[^.!?\n]{0,40}\b(?:accurate|well[- ]?structured|solid|fine|good|great|strong|correct|clear|clean|in good shape)\b|\botherwise\b[^.!?\n]{0,30}\b(?:it'?s|looks?|reads?|seems?)\b[^.!?\n]{0,30}\b(?:good|solid|fine|strong|clean|great)\b/i;

export function tagOperatorFailureShapes(
  input: FailureShapeInput,
): OperatorFailureShape[] {
  const out = new Set<OperatorFailureShape>();
  const text = typeof input.output_text === "string" ? input.output_text : "";
  if (!text.trim()) return [];

  const readRan = ranAnyReadTool(input.tool_calls);
  const handoffRan = ranHandoff(input.tool_calls);
  const lookupAsk =
    (typeof input.question === "string" && LOOKUP_RE.test(input.question)) ||
    (!input.question && LOOKUP_RE.test(text));

  if (DENIAL_RE.test(text) && !readRan && lookupAsk) {
    out.add("capability-denial");
  }

  if (COMPLETENESS_RE.test(text) && !readRan) {
    out.add("completeness-overclaim");
  }

  if (HAS_NUMERIC.test(text)) {
    for (const [a, b] of CONFUSABLE_METRIC_PAIRS) {
      if (a.test(text) && b.test(text)) {
        out.add("metric-mislabel");
        break;
      }
    }
  }

  if (handoffRan && lookupAsk) {
    out.add("dead-end-punt");
  }

  if (
    typeof input.question === "string" &&
    REVIEW_ASK_RE.test(input.question) &&
    REVIEW_REMAINDER_HEDGE_RE.test(text)
  ) {
    out.add("shallow-review");
  }

  return OPERATOR_FAILURE_SHAPES.filter((s) => out.has(s));
}
