
const LIVE_STATE_PATTERNS: readonly RegExp[] = [
  /\b(currently|right\s+now|at\s+the\s+moment|as\s+of\s+(today|now))\b/i,
  /\b(today|now)\b/i,
  /\b(this\s+(week|month|year)|so\s+far\s+(this|today))\b/i,
  /\b(is|are)\s+[^?\n]{1,80}?\s+(still|active|paused|connected|live|running|working|enabled|disabled|on|off|up|down|broken|stopped|started)\b/i,
  /\b(status|state)\s+of\b/i,
  /\b(current|live|present)\s+(status|state|value|spend|budget|count|number|amount|total|version|config|setting|rate|cap|limit)\b/i,
  /\b(did|has|have|was|were)\s+[^?\n]{1,80}?\s+(change|changed|doubled|tripled|increased|decreased|gone\s+up|gone\s+down|been\s+(updated|modified|paused|stopped|started|deleted|removed))\b/i,
  /\b(doubled|tripled|quadrupled|halved)\b/i,
  /\b(does|do)\s+[^?\n]{1,80}?\s+(exist|still\s+exist)\b/i,
  /\b(is|are)\s+there\s+(a|an|any)\s+\S+/i,
  /\b(how\s+much|how\s+many)\b[^?.]*\b(now|today|currently|this\s+(week|month))\b/i,
];

export function isLiveStateQuestion(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (t.length < 3) return false;
  for (const re of LIVE_STATE_PATTERNS) {
    if (re.test(t)) return true;
  }
  return false;
}

export const LIVE_STATE_PATTERN_COUNT: number = LIVE_STATE_PATTERNS.length;
