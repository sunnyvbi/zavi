
const FINDING = String.raw`(?!.*\b(?:and|but|so|is|are|was|were|isn't|aren't|wasn't|has|have|had|shows?|showed|found|because|no|none|nothing|nobody|zero|not|never|only|didn't|couldn't|can't|cannot|won't|doesn't|matched?|empty)\b)`;
const OPENER = String.raw`(?:(?:ok(?:ay)?|alright|now|right),?\s+)?`;
const re = (body: string) => new RegExp(`^${body}$`, "i");

const PROGRESS: RegExp[] = [
  re(String.raw`${OPENER}(?:the\s+|your\s+)?(?:numbers|data|results|figures|reads?|query results?)\s+(?:are|is)\s+(?:all\s+)?(?:in|back)(?:\s+now)?`),
  re(String.raw`${OPENER}(?:i'?m\s+|i am\s+)?(?:writing|checking|reading|digging|looking|working|wrapping)\b${FINDING}[a-z' ,-]{0,60}\s+now`),
  re(String.raw`${OPENER}(?:i'?m\s+|i am\s+)?(?:pulling|running|crunching)\s+(?:the\s+|your\s+)?(?:numbers|data|figures|results|queries|query)(?:\s+now)?`),
  re(String.raw`${OPENER}let me\s+(?:check|pull|look|dig|write|read|grab|crunch|go through|take a look)\b${FINDING}[a-z' ,-]{0,60}`),
  re(String.raw`${OPENER}i(?:'ve| have)?\s+(?:got|have)\s+(?:the full picture|everything i need|what i need|the numbers|the data|enough)(?:\s+now)?`),
];

const MAX_NARRATION_CHARS = 160;
const MAX_PARAGRAPHS_REMOVED = 2;

function plain(line: string): string {
  return line.replace(/^[*_]+|[*_]+$/g, "").trim();
}

export function isProgressNarration(paragraph: string): boolean {
  const p = plain(paragraph.trim());
  if (!p || p.length > MAX_NARRATION_CHARS || p.includes("\n")) return false;
  if (/[\d:?]/.test(p)) return false;
  const sentences = p
    .split(/(?<=[.!…])\s+/)
    .map((x) => plain(x).replace(/[.!…]+$/, "").trim())
    .filter(Boolean);
  if (sentences.length === 0) return false;
  return sentences.every((s) => PROGRESS.some((r) => r.test(s)));
}

export function stripLeadNarration(text: string): { text: string; stripped: boolean } {
  let rest = text;
  let stripped = false;
  for (let i = 0; i < MAX_PARAGRAPHS_REMOVED; i++) {
    const lead = rest.replace(/^\s+/, "");
    const m = lead.match(/^([^\n]*)\n[ \t]*\n([\s\S]*)$/);
    if (!m) break;
    const [, first, after] = m;
    if (after.trim().length === 0 || !isProgressNarration(first)) break;
    rest = after;
    stripped = true;
  }
  return stripped ? { text: rest.replace(/^\s+/, ""), stripped } : { text, stripped };
}
