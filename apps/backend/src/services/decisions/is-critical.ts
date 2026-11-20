
const CRITICAL_CLASS_RE =
  /(^|[._-])(security|auth|password|payment|billing|refund|dispute|chargeback|payout|stripe|fraud|privacy|pii|credential)([._-]|$)/i;

const SUMMARY_CLASS_RE = /(daily-digest|digest|summary|report|recap|notetaker)/i;

const ABUSE_VERB = String.raw`expos\w*|leak\w*|unauthor[i]?z\w*|breach\w*|steal|stolen|enumerat\w*|dump|read|access\w*|scrape\w*|harvest\w*`;
const PAYMENT_METHOD_ABUSE = String.raw`(?:${ABUSE_VERB})[^.\n]{0,60}payment method|payment method[^.\n]{0,60}(?:${ABUSE_VERB})`;

const ACTIVE_FRAUD = String.raw`card[-_. ]?testing|carding attack|fraudulent charge`;

const CRITICAL_LEXICON_RE = new RegExp(
  `(account takeover|takeover vect|reset token|password reset|password hash|\\bidor\\b|\\bmfa\\b|\\b2fa\\b|authentication bypass|auth bypass|privilege escal|session (?:fixation|hijack|remains valid)|\\bcredential|unauthor[i]?z|\\bexploit|vulnerab|\\bcve\\b|data (?:loss|leak|breach)|\\bpii\\b|exposed (?:key|secret|token|private)|leak(?:ing|ed)? (?:key|secret|token|password|payment|card)|chargeback|unauthorized (?:refund|payout|charge)|\\bpayout\\b|deploy key|${PAYMENT_METHOD_ABUSE}|${ACTIVE_FRAUD})`,
  "i",
);

function bodyToText(body: unknown): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return "";
  }
}

export function isCriticalDecision(
  decisionClass: string | null | undefined,
  body: unknown,
): boolean {
  const cls = decisionClass ?? "";
  if (SUMMARY_CLASS_RE.test(cls)) return false;
  if (CRITICAL_CLASS_RE.test(cls)) return true;
  return CRITICAL_LEXICON_RE.test(bodyToText(body));
}
