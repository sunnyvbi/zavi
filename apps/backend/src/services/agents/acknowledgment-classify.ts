
const ACK_MAX_CHARS = 24;

const ACK_PATTERNS: readonly RegExp[] = [
  /^ok$/i,
  /^okay$/i,
  /^k$/i,
  /^kk$/i,
  /^okie$/i,
  /^okey$/i,
  /^cool$/i,
  /^nice$/i,
  /^great$/i,
  /^awesome$/i,
  /^perfect$/i,
  /^thanks$/i,
  /^thank you$/i,
  /^thx$/i,
  /^ty$/i,
  /^thank you so much$/i,
  /^got it$/i,
  /^gotcha$/i,
  /^understood$/i,
  /^noted$/i,
  /^good to know$/i,
  /^alright$/i,
  /^all right$/i,
  /^roger$/i,
  /^ack$/i,
  /^ok(?:ay)? (?:thanks|thank you|cool|got it|sounds good|will do)$/i,
  /^(?:thanks|thank you|thx),? ?(?:a lot|so much|much)?$/i,
  /^(?:great|nice|perfect|awesome|cool),? thanks$/i,
];

export function isPureAcknowledgment(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const stripped = text
    .trim()
    .replace(/[\s.!…,;:)\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+$/u, "")
    .trim();
  if (stripped.length === 0) return false;
  if (stripped.length > ACK_MAX_CHARS) return false;
  return ACK_PATTERNS.some((pat) => pat.test(stripped));
}

const GRATITUDE_PATTERNS: readonly RegExp[] = [
  /^thanks?$/i,
  /^thank ?(?:you|u)$/i,
  /^thx$/i,
  /^ty$/i,
  /^tysm$/i,
  /^thank ?(?:you|u) (?:so|very) much$/i,
  /^thanks? (?:so much|a lot|a ton|much|again|man|mate|team)$/i,
  /^(?:many )?thanks? (?:much|again)?$/i,
  /^thanks? (?:very|so) much$/i,
  /^(?:much )?appreciated$/i,
  /^appreciate (?:it|you|that)$/i,
  /^cheers$/i,
];

export function isPureGratitude(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const stripped = text
    .trim()
    .replace(/[\s.!…,;:)\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+$/u, "")
    .trim();
  if (stripped.length === 0) return false;
  if (stripped.length > ACK_MAX_CHARS) return false;
  return GRATITUDE_PATTERNS.some((pat) => pat.test(stripped));
}

export function isContextFreeCourtesy(text: string | null | undefined): boolean {
  return isPureGratitude(text) || isLowIntentGreeting(text);
}

const GREETING_MAX_CHARS = 24;

const GREETING_PATTERNS: readonly RegExp[] = [
  /^h(?:e?l+o+|i+|ey+|iya|ello there)$/i,
  /^yo+$/i,
  /^hey there$/i,
  /^hi there$/i,
  /^hello there$/i,
  /^howdy$/i,
  /^greetings$/i,
  /^good (?:morning|afternoon|evening|day)$/i,
  /^(?:hey|hi|hello|yo) (?:there|all|team|everyone)$/i,
];

export function isLowIntentGreeting(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const stripped = text
    .trim()
    .replace(/[\s.!…,;:)\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+$/u, "")
    .trim();
  if (stripped.length === 0) return false;
  if (stripped.length > GREETING_MAX_CHARS) return false;
  return GREETING_PATTERNS.some((pat) => pat.test(stripped));
}

const OFFER_CUES: readonly RegExp[] = [
  /\breply\b/i,
  /\blet me know\b/i,
  /\bwant me to\b/i,
  /\bshould i\b/i,
  /\bshall i\b/i,
  /\bsay the word\b/i,
  /\bjust say\b/i,
  /\bi'?ll (?:proceed|go ahead|ship|run|start)\b/i,
  /\bto confirm\b/i,
  /\btell me what to adjust\b/i,
  /\bconfirm to\b/i,
];

export function endsWithQuestionOrOffer(
  priorAssistantBody: string | null | undefined,
): boolean {
  if (typeof priorAssistantBody !== "string") return false;
  const trimmed = priorAssistantBody.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.endsWith("?")) return true;
  const tail = trimmed.slice(-160);
  return OFFER_CUES.some((re) => re.test(tail));
}

export function shouldSuppressAsAck(args: {
  message: string | null | undefined;
  priorAssistantBody: string | null | undefined;
  priorWasClarify: boolean;
}): boolean {
  return (
    isPureAcknowledgment(args.message) &&
    !args.priorWasClarify &&
    !endsWithQuestionOrOffer(args.priorAssistantBody)
  );
}
