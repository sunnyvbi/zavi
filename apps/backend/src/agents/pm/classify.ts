
export type ProductPmMode = "delivery" | "strategy_memo" | "iterate";

const STRATEGY_INTENT = new RegExp(
  [
    "\\b(pricing|monetiz|free tier|paywall|take[- ]rate)\\b",
    "\\bicp\\b|\\bideal customer\\b|\\btarget (customer|market|audience)\\b",
    "\\bpositioning\\b|\\bcompetitive (wedge|moat|advantage)\\b|\\bwedge\\b",
    "\\bgo[- ]to[- ]market\\b|\\bgtm\\b",
    "\\b(should|do|can) we (build|launch|pivot|raise|expand|differentiate)\\b",
    "\\bwhy would (anyone|someone|a customer)\\b",
    "\\bhow (do|can|should) (i|we) (grow|win|compete|scale|differentiate|monetize|position)\\b",
    "\\b(grow|growth|churn|retention|acquisition|expansion) (strategy|plan|problem|lever|play)\\b",
  ].join("|"),
  "i",
);

const ENGINEER_HANDOFF_INTENT = new RegExp(
  [
    "\\b(send|hand|give|pass|route|forward|ship|push)\\b[^.?!]{0,40}\\bto (the )?engineer\\b",
    "\\b(have|get|ask|tell)\\b[^.?!]{0,20}\\bengineer\\b[^.?!]{0,30}\\b(build|implement|fix|update|ship|do|work on|code|create|add|change|wire)\\b",
    "\\b(dispatch|fire|kick ?off|assign|bring in|loop in|hand ?off)\\b[^.?!]{0,15}\\b(the )?engineer\\b",
    "\\bengineer\\b[^.?!]{0,15}\\b(should|to|can you|please|needs to)\\b[^.?!]{0,20}\\b(build|implement|fix|update|ship|do|work on|code|create|add|wire)\\b",
  ].join("|"),
  "i",
);

export function isEngineerHandoffIntent(text: string | undefined): boolean {
  return ENGINEER_HANDOFF_INTENT.test((text ?? "").trim());
}

export function classifyProductPmMode(args: {
  trigger: string | undefined;
  userText: string | undefined;
  hasPriorArtifact?: boolean;
}): ProductPmMode {
  if (args.trigger !== "chat") return "delivery";
  const text = (args.userText ?? "").trim();
  if (text.length === 0) return "delivery";
  if (text.length < 8 && args.hasPriorArtifact !== true) return "delivery";
  if (ENGINEER_HANDOFF_INTENT.test(text)) return "delivery";
  if (STRATEGY_INTENT.test(text)) return "strategy_memo";
  if (args.hasPriorArtifact === true) return "iterate";
  return "delivery";
}

export type PmChatModeDecision = ProductPmMode | "ambiguous";

const STRATEGY_SHAPE = new RegExp(
  [
    "\\b(vs\\.?|versus)\\b.{0,60}\\b(call|decision|bet|choice|approach|right|balance)\\b",
    "\\btrade[- ]?off(s)?\\b",
    "\\bwhat'?s the (call|right call|right move|right balance|real|actual)\\b",
    "\\bwhich (bet|option|path|way|direction|approach)\\b",
    "\\b(prioriti[sz]e|choose|decide|balance) between\\b",
    "\\bhow (hard|much) (do|should) we (clamp|tighten|lean|push)\\b",
    "\\b(should|do) we (charge|monetize|gate|expand|roll ?out|launch wide|go wide)\\b",
    "\\b(charge|charging|take|taking) (a |an )?(fee|take[- ]rate|commission|cut)\\b",
    "\\bgo wide\\b|\\bnationwide\\b",
    "\\b(launch|roll ?out|expand) (wide|nationwide|everywhere|in one|in a single|region by region|state by state)\\b",
  ].join("|"),
  "i",
);

const DELIVERY_SHAPE =
  /\b(rice[- ]?rank|rice score|backlog|bottleneck|what to ship|ship next|sprint|rank(ed)? (list|shortlist|the)|prioriti[sz]ed (list|backlog))\b/i;

export function classifyProductPmChatModeRaw(args: {
  trigger: string | undefined;
  userText: string | undefined;
  hasPriorArtifact?: boolean;
}): PmChatModeDecision {
  if (args.trigger !== "chat") return "delivery";
  const text = (args.userText ?? "").trim();
  if (text.length === 0) return "delivery";
  if (text.length < 8 && args.hasPriorArtifact !== true) return "delivery";
  if (ENGINEER_HANDOFF_INTENT.test(text)) return "delivery";
  const verbMatch = STRATEGY_INTENT.test(text);
  const shapeMatch = STRATEGY_SHAPE.test(text);
  const looksDelivery = DELIVERY_SHAPE.test(text);
  if (verbMatch && looksDelivery) return "ambiguous";
  if (!verbMatch && shapeMatch) return "ambiguous";
  if (verbMatch) return "strategy_memo";
  if (args.hasPriorArtifact === true) return "iterate";
  return "delivery";
}

