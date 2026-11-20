
export type QueryIntent = "entity" | "temporal" | "event" | "general";
export type AxisMode = "off" | "on" | "strong";
export type DetailLevel = "low" | "medium" | "high";

export type QuerySuggestions = {
  intent: QueryIntent;
  suggestedRecency: AxisMode;
  suggestedSalience: AxisMode;
  suggestedDetail?: DetailLevel;
};

const TEMPORAL_PATTERNS = [
  /\bwhen\b/i,
  /\blast\s+(met|meeting|call|conversation|chat|talked|spoke|seen|heard|time|week|month|quarter|year)\b/i,
  /\brecent(ly)?\b/i,
  /\bhistory\b/i,
  /\btimeline\b/i,
  /\bwhat('s| is| was)\s+new\b/i,
  /\blatest\b/i,
  /\bupdate(s)?\s+(on|from|about)\b/i,
  /\bhow\s+long\s+(ago|since)\b/i,
  /\bsince\b/i,
  /\bago\b/i,
  /\b\d{4}[-/]\d{2}\b/,
  /\byesterday\b/i,
  /\btoday\b/i,
  /\bthis\s+(week|month|quarter|year)\b/i,
];

const EVENT_PATTERNS = [
  /\bannounce[ds]?(ment)?\b/i,
  /\blaunch(ed|es|ing)?\b/i,
  /\braised?\s+\$?\d/i,
  /\bfund(ing|raise)\b/i,
  /\bIPO\b/i,
  /\bacquisition\b/i,
  /\bmerge[drs]?\b/i,
  /\bnews\b/i,
  /\bhappened?\b/i,
  /\bdispute\b/i,
  /\bescalat(e|ed|ion)\b/i,
];

const ENTITY_PATTERNS = [
  /\bwho\s+is\b/i,
  /\bwhat\s+(is|does|are)\b/i,
  /\btell\s+me\s+about\b/i,
  /\bdescribe\b/i,
  /\bsummar(y|ize)\b/i,
  /\boverview\b/i,
  /\bprofile\b/i,
  /\bbackground\s+on\b/i,
];

const STRONG_RECENCY = [
  /\bright\s+now\b/i,
  /\btoday\b/i,
  /\bjust\s+(happened|now)\b/i,
  /\bthis\s+(week|morning|afternoon)\b/i,
];

const STRONG_SALIENCE = [
  /\btell\s+me\s+about\b/i,
  /\bwho\s+is\b/i,
  /\bgive\s+me\s+(an?\s+)?overview\b/i,
];

function any(patterns: RegExp[], q: string): boolean {
  for (const re of patterns) if (re.test(q)) return true;
  return false;
}

export function classifyQuery(query: string): QuerySuggestions {
  if (typeof query !== "string" || query.trim().length === 0) {
    return { intent: "general", suggestedRecency: "off", suggestedSalience: "off" };
  }

  const temporal = any(TEMPORAL_PATTERNS, query);
  const event = any(EVENT_PATTERNS, query);
  const entity = any(ENTITY_PATTERNS, query);

  let intent: QueryIntent = "general";
  if (temporal) intent = "temporal";
  else if (event) intent = "event";
  else if (entity) intent = "entity";

  let suggestedRecency: AxisMode = "off";
  if (temporal || event) suggestedRecency = "on";
  if (any(STRONG_RECENCY, query)) suggestedRecency = "strong";

  let suggestedSalience: AxisMode = "off";
  if (entity) suggestedSalience = "on";
  if (any(STRONG_SALIENCE, query)) suggestedSalience = "strong";

  let suggestedDetail: DetailLevel | undefined;
  if (intent === "entity") suggestedDetail = "low";
  else if (intent === "temporal" || intent === "event") suggestedDetail = "high";

  return { intent, suggestedRecency, suggestedSalience, suggestedDetail };
}
