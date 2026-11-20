
export const CONTACT_REDACTION = "[contact removed, keep it on Zavi]";

type Rule = { name: ContactKind; re: RegExp };

export type ContactKind = "email" | "phone" | "link" | "address";

const STREET_WORD =
  "street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|way|terrace|ter|place|pl|circle|cir|highway|hwy|suite|ste|apt|apartment|unit";

const GAP_STOPWORDS = [
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "by", "for", "from", "had", "has",
  "have", "her", "his", "in", "is", "it", "its", "me", "my", "no", "not", "of", "on", "or", "our",
  "out", "she", "than", "that", "the", "their", "them", "there", "they", "this", "to", "up", "was",
  "we", "were", "will", "with", "you", "your",
];

function buildAddressRule(): RegExp {
  const gapWord = `(?!(?:${GAP_STOPWORDS.join("|")})\\b)[A-Za-z0-9.'-]+`;
  return new RegExp(
    `(?<![\\d.,$])\\b\\d{1,6}\\s+(?:${gapWord}\\s+){1,4}(?:${STREET_WORD})\\b\\.?`,
    "gi",
  );
}

const RULES: Rule[] = [
  {
    name: "email",
    re: /[A-Z0-9._%+-]+\s?(?:@|\(at\)|\[at\])\s?[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  },
  {
    name: "link",
    re: /\b(?:wa\.me|t\.me|telegram(?:\.me)?|whatsapp(?:\.com)?|signal\.me|calendly\.com|discord\.gg|cash\.app|venmo\.com|paypal\.me)\S*/gi,
  },
  {
    name: "phone",
    re: /(?:\+?\d[\s().-]{0,2}){9,}\d/g,
  },
  {
    name: "address",
    re: buildAddressRule(),
  },
];

export type ScrubResult = {
  body: string;
  removed: ContactKind[];
};

export function scrubContact(body: string): ScrubResult {
  let out = body;
  const removed: ContactKind[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    if (!rule.re.test(out)) continue;
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, CONTACT_REDACTION);
    removed.push(rule.name);
  }
  return { body: out, removed };
}
