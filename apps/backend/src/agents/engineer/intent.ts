
export const INFO_VERBS: readonly string[] = [
  "check",
  "list",
  "find",
  "show",
  "what",
  "how",
  "why",
  "is there",
  "are there",
  "when did",
  "how many",
  "who",
  "where",
  "explain",
  "describe",
  "update me",
  "status",
];

export const SHIP_VERBS: readonly string[] = [
  "add",
  "fix",
  "change",
  "refactor",
  "remove",
  "ship",
  "wire",
  "implement",
  "migrate",
  "build",
  "create",
  "open a pr",
  "open pr",
  "replace",
  "rename",
  "update",
  "delete",
  "set",
  "enable",
  "disable",
];

export const DESIGN_SHIP_VERBS: readonly string[] = [
  "design",
  "redesign",
  "mock up",
  "mockup",
  "wireframe",
  "prototype",
  "sketch",
];

const INFO_LEANING_OPENERS: readonly string[] = [
  "update me",
  "show",
  "list",
  "status",
  "what",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMatcher(verbs: readonly string[]): RegExp {
  const alts = verbs
    .map((v) => escapeRegExp(v).replace(/\\?\s+/g, "\\s+"))
    .join("|");
  return new RegExp(`\\b(?:${alts})\\b`, "i");
}

const INFO_RE = buildMatcher(INFO_VERBS);
const SHIP_RE = buildMatcher(SHIP_VERBS);

const DESIGN_ALTS = [
  "design",
  "designing",
  "redesign",
  "redesigning",
  "mock[\\s-]?up",
  "mocking[\\s-]?up",
  "wireframe",
  "wireframing",
  "prototype",
  "prototyping",
  "sketch",
  "sketching",
].join("|");
const DESIGN_WORD_RE_G = new RegExp(`\\b(?:${DESIGN_ALTS})\\b`, "ig");

function labelPrefixEnd(text: string): number {
  const colon = text.slice(0, 60).indexOf(":");
  if (colon < 0) return -1;
  const head = text.slice(0, colon).trim();
  if (/\b(?:a|an|the|my|our|me|us|this|that|these|those|new)\b/i.test(head)) return -1;
  if (head.split(/[\s-]+/).filter(Boolean).length > 3) return -1;
  return colon;
}

function firstDesignImperativeIndex(text: string): number {
  const labelColon = labelPrefixEnd(text);
  DESIGN_WORD_RE_G.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DESIGN_WORD_RE_G.exec(text)) !== null) {
    const at = m.index;
    if (labelColon >= 0 && at < labelColon) continue;
    const before = text.slice(Math.max(0, at - 2), at);
    if (/['’]s$/i.test(text.slice(Math.max(0, at - 3), at)) || /['’]$/.test(before)) continue;
    const after = text.slice(at + m[0].length);
    if (/^\s*[?.!]?\s*$/.test(after)) continue;
    return at;
  }
  return -1;
}
const INFO_LEANING_RE = buildMatcher(INFO_LEANING_OPENERS);

function buildGlobalMatcher(verbs: readonly string[]): RegExp {
  const alts = verbs
    .map((v) => escapeRegExp(v).replace(/\\?\s+/g, "\\s+"))
    .join("|");
  return new RegExp(`\\b(?:${alts})\\b`, "ig");
}
const INFO_RE_G = buildGlobalMatcher(INFO_VERBS);
const SHIP_RE_G = buildGlobalMatcher(SHIP_VERBS);

const CLAUSE_SEPARATOR_RE = /(?:\bthen\b|\band\b|,|;)/i;

function firstVerbIndex(re: RegExp, text: string): number {
  re.lastIndex = 0;
  const m = re.exec(text);
  return m ? m.index : -1;
}

export function resolveCtoChatIntent(
  message: string,
): "info" | "ship" | "ambiguous" {
  const text = (message ?? "").trim();
  if (text.length < 4) return "ambiguous";

  const hasInfo = INFO_RE.test(text);
  const hasShip = SHIP_RE.test(text) || firstDesignImperativeIndex(text) >= 0;
  const startsInfoLeaning = INFO_LEANING_RE.test(text.slice(0, 24));

  if (hasInfo && !hasShip) return "info";
  if (hasShip && !hasInfo) return "ship";

  if (hasInfo && hasShip) {
    if (CLAUSE_SEPARATOR_RE.test(text)) return "ambiguous";
    const infoIdx = firstVerbIndex(INFO_RE_G, text);
    const plainShipIdx = firstVerbIndex(SHIP_RE_G, text);
    const designIdx = firstDesignImperativeIndex(text);
    const shipIdx =
      plainShipIdx < 0 ? designIdx : designIdx < 0 ? plainShipIdx : Math.min(plainShipIdx, designIdx);
    return infoIdx <= shipIdx ? "info" : "ship";
  }

  if (startsInfoLeaning) return "info";
  return "ambiguous";
}
