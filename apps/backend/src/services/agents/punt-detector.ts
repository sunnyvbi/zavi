
export type PuntClass =
  | "do_it_yourself"
  | "cant_from_here"
  | "tools_unreachable"
  | "no_browser"
  | "asked_for_record"
  | "skipped_web_search";

export type PuntDetection = { punt: boolean; matched?: PuntClass };

const DO_VERBS = "(?:open|run|visit|check|test|trigger|load|kick\\s+off|go\\s+to|try)";
const CANT = "(?:can'?t|cannot|am\\s+unable\\s+to|'m\\s+unable\\s+to|am\\s+not\\s+able\\s+to|'m\\s+not\\s+able\\s+to|won'?t\\s+be\\s+able\\s+to|have\\s+no\\s+way\\s+to)";
const CANT_VERBS = "(?:trigger|run|test|open|access|browse|visit|load|reach|kick\\s+off|check)";

const PATTERNS: ReadonlyArray<[PuntClass, RegExp]> = [
  [
    "cant_from_here",
    new RegExp(
      `\\bI\\s*${CANT}\\b.{0,80}?\\b${CANT_VERBS}\\b.{0,100}?\\bfrom\\s+(?:here|this\\s+(?:chat|thread|dm|conversation|channel)|slack)\\b`,
      "i",
    ),
  ],
  [
    "tools_unreachable",
    /\b(?:not|isn't|aren't)\s+(?:reachable|accessible)\s+(?:from|with|via|through)\s+my\s+tools\b|\bmy\s+tools\s+(?:can'?t|cannot)\s+reach\b/i,
  ],
  [
    "no_browser",
    /\bI\s+(?:don'?t|do\s+not)\s+have\s+(?:a\s+|any\s+)?(?:web\s+)?browser(?:\s+access)?\b/i,
  ],
  ["do_it_yourself", /\bgo\s+to\b.{0,120}?\byourself\b/i],
  [
    "do_it_yourself",
    new RegExp(
      `\\byou(?:'ll|\\s+will)?\\s+(?:need|have)\\s+to\\b.{0,40}?\\b${DO_VERBS}\\b.{0,120}?\\byourself\\b`,
      "i",
    ),
  ],
  [
    "do_it_yourself",
    new RegExp(`^(?:please\\s+)?${DO_VERBS}\\b.{0,120}?\\byourself\\b`, "i"),
  ],
];

const FOUNDER_ONLY_STEP =
  /\b(?:connect(?:ed|ing|or|ors|ion)?|integrations?|settings|re-?auth\w*|oauth|log\s*-?\s*in|sign\s*-?\s*in|2fa|two[-\s]factor|(?:verification|security|login|sms|one[-\s]time|2fa|auth(?:entication)?)\s+code|the\s+code\s+(?:we|I)\s+(?:sent|texted|emailed)|password|credentials?|approv\w*|permissions?|verify\s+(?:your\s+|the\s+)?(?:domain|ownership|site\s+ownership)|verify\s+(?:that\s+)?you\s+own\s+(?:the\s+|your\s+)?(?:domain|site)|domain\s+verification|dns|txt\s+record)\b/i;

function sentences(text: string): string[] {
  return text
    .replace(/[‘’]/g, "'")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[\s>*\-•\d.)]+/, "").trim())
    .filter(Boolean);
}

export function detectPunt(text: string | null | undefined): PuntDetection {
  if (!text) return { punt: false };
  for (const sentence of sentences(text)) {
    if (FOUNDER_ONLY_STEP.test(sentence)) continue;
    for (const [cls, re] of PATTERNS) {
      if (re.test(sentence)) return { punt: true, matched: cls };
    }
  }
  return { punt: false };
}

const ASK_VERB = "(?:send|share|paste|give|provide|drop|post|forward)";
const RECORD_NOUN =
  "(?:\\b(?:listing|order|booking|reservation|user|customer|account|product|record|item|transaction|trip|invoice|row|entry)\\s+(?:id|ids|number|no\\.?|#|url|link)\\b|\\bids?\\b|\\bidentifier\\b|\\b(?:link|url)\\s+(?:to|for)\\s+(?:the|that|this|its|their|your)\\b)";
const RECORD_ASK = new RegExp(
  `(?:\\b(?:can|could|would)\\s+you\\s+(?:please\\s+)?${ASK_VERB}|\\bplease\\s+${ASK_VERB}|\\bsend\\s+me|\\bif\\s+you\\s+${ASK_VERB}|(?:^|:\\W*)${ASK_VERB}\\b)` +
    `.{0,60}?${RECORD_NOUN}`,
  "i",
);
const RECORD_QUESTION = new RegExp(`\\bwhat(?:'s|\\s+is|\\s+are)\\b.{0,40}?${RECORD_NOUN}.*\\?\\s*$`, "i");
const CHOICE = /\b(?:whether|which)\b.{0,80}\bor\b/i;

export function detectRecordAsk(text: string | null | undefined): boolean {
  if (!text) return false;
  return sentences(text).some(
    (s) => !FOUNDER_ONLY_STEP.test(s) && !CHOICE.test(s) && (RECORD_ASK.test(s) || RECORD_QUESTION.test(s)),
  );
}

const OWN = "(?:our|my|your|their|this|that|these|the|it)";
const RESEARCH_ASK: readonly RegExp[] = [
  new RegExp(
    `\\b(?:vs\\.?|versus)\\s+(?!(?:last|previous|prior|${OWN})\\b)\\S|\\b(?:difference\\s+between|alternatives?\\s+to)\\s+(?!${OWN}\\b)`,
    "i",
  ),
  /(?<!\b(?:our|my|your|their|its)\s+)\b(?:best|top|leading|popular)\s+(?:\d+\s+)?(?:[\w-]+\s+){0,3}(?:platforms?|tools?|apps?|sites?|websites?|channels?|agencies|networks?|marketplaces?|providers?|services|software|options|vendors?|creators?|influencers?|communities|subreddits?|newsletters?|podcasts?)\b/i,
  /\b(?:current|latest|today'?s)\s+(?:[\w-]+\s+){0,2}(?:polic(?:y|ies)|pricing|prices?|rules|requirements|fees|limits)\b|\b(?:ad|ads|advertising|content|platform)\s+polic(?:y|ies)\b/i,
  /\b(?:is|are|would|will)\s+(?!(?:this|that|these|he|she|they|it|our|my|your)\b).{1,60}?\b(?:a|good|right|bad|great)\s+fit\b/i,
  /\b[Hh]ow\s+(?:much\s+(?:does|do|would|will)\s+(?!I\b)[A-Z].{0,60}?\bcost|(?:does|do)\s+(?!I\b)[A-Z].{0,60}?\bwork)\b/,
];
const OWN_PLAN = /\b(?:plans?|tiers?|packages?|pricing\s+page)\b/i;

export function isResearchAsk(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.replace(/[‘’]/g, "'").slice(0, 2000);
  const [comparison, ...rest] = RESEARCH_ASK;
  return (comparison.test(t) && !OWN_PLAN.test(t)) || rest.some((re) => re.test(t));
}

export const PUNT_RETRY_FLAG = "_punt_guard_retry";
export const PUNT_RETRY_NOTE_KEY = "_punt_guard_note";

export function puntGuardNoteFromPayload(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p[PUNT_RETRY_FLAG] !== true) return null;
  return typeof p[PUNT_RETRY_NOTE_KEY] === "string" ? (p[PUNT_RETRY_NOTE_KEY] as string) : null;
}

export function isPuntRetry(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as Record<string, unknown>)[PUNT_RETRY_FLAG] === true
  );
}

export function withPuntRetry(payload: unknown, note: string): Record<string, unknown> {
  const base =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : { input: payload };
  return { ...base, [PUNT_RETRY_FLAG]: true, [PUNT_RETRY_NOTE_KEY]: note };
}

