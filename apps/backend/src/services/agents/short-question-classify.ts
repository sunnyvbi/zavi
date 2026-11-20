
const TERSE_MARKERS =
  /\b(?:yes\s+or\s+no|y\/n|true\s+or\s+false|tl[\s;]*dr|short\s+answer|one\s+line)\b/i;

export const FULL_REQUEST_MARKERS =
  /\b(?:full|weekly|monthly|quarterly|yearly|comprehensive|complete|detailed|in[\s-]depth)\s+(?:digest|report|review|rundown|breakdown|analysis|summary|update|brief|overview|run)\b|\b(?:give\s+me\s+the\s+(?:full|whole)|run\s+the\s+report|deep\s+dive|walk\s+me\s+through|tell\s+me\s+everything|the\s+(?:whole|full)\s+picture)\b/i;

export function isFullRequest(text: string | null | undefined): boolean {
  return !!text && FULL_REQUEST_MARKERS.test(text);
}

const SHORT_WORD_COUNT_CAP = 14;

export function isShortQuestion(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (t.length < 3) return false;
  if (TERSE_MARKERS.test(t)) return true;
  if (FULL_REQUEST_MARKERS.test(t)) return false;
  const wordCount = t.split(/\s+/).filter((w) => w.length > 0).length;
  return wordCount <= SHORT_WORD_COUNT_CAP;
}

export function resolveResponseShape(args: {
  responseContract: "auto" | "digest" | "terse" | undefined;
  hasEnvelope: boolean;
  questionText: string | null | undefined;
}): { shape: "digest" | "terse"; short_question: boolean } {
  const contract = args.responseContract ?? "auto";
  const short = isShortQuestion(args.questionText);
  if (contract === "digest") return { shape: "digest", short_question: short };
  if (contract === "terse") return { shape: "terse", short_question: short };
  return {
    shape: args.hasEnvelope && short ? "terse" : "digest",
    short_question: short,
  };
}
