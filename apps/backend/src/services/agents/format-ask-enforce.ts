
export type FormatConstraint =
  | "no_headings"
  | "one_paragraph"
  | "one_sentence"
  | "one_line";

const ONE_SENTENCE = /\b(?:in\s+)?(?:one|a\s+single|1)\s+sentence\b/i;
const ONE_LINE =
  /\b(?:in\s+)?(?:one|a\s+single|1)\s+line\b|\btl[\s;:]*dr\b|\bsummar(?:ize|ise)\s+in\s+one\s+line\b/i;
const ONE_PARAGRAPH = /\b(?:in\s+)?(?:one|a\s+single|1)\s+paragraph\b/i;
const NO_HEADINGS =
  /\bno\s+headings?\b|\bwithout\s+headings?\b|\bno\s+headers?\b|\bprose\s+only\b|\bplain\s+prose\b|\bno\s+markdown\s+headings?\b/i;

export function detectFormatConstraint(
  userMessage: string | null | undefined,
): FormatConstraint | null {
  if (typeof userMessage !== "string") return null;
  const t = userMessage;
  if (t.trim().length < 3) return null;
  if (ONE_SENTENCE.test(t)) return "one_sentence";
  if (ONE_LINE.test(t)) return "one_line";
  if (ONE_PARAGRAPH.test(t)) return "one_paragraph";
  if (NO_HEADINGS.test(t)) return "no_headings";
  return null;
}

const ATX_HEADING = /^\s{0,3}#{1,6}\s+\S/;

const BOLD_ONLY_HEADING = /^\s*\*\*[^*\n]+\*\*\s*:?\s*$/;

const LIST_LINE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/;

export function splitFencedCode(
  body: string,
): Array<{ code: boolean; text: string }> {
  const segments: Array<{ code: boolean; text: string }> = [];
  const lines = body.split("\n");
  let buf: string[] = [];
  let inCode = false;
  const flush = (code: boolean) => {
    if (buf.length > 0) segments.push({ code, text: buf.join("\n") });
    buf = [];
  };
  for (const line of lines) {
    const isFence = /^\s*```/.test(line);
    if (isFence) {
      if (!inCode) {
        flush(false);
        inCode = true;
        buf.push(line);
      } else {
        buf.push(line);
        flush(true);
        inCode = false;
      }
      continue;
    }
    buf.push(line);
  }
  flush(inCode);
  return segments;
}

function stripHeadingsFromProse(text: string): string {
  return text
    .split("\n")
    .filter((line) => !ATX_HEADING.test(line) && !BOLD_ONLY_HEADING.test(line))
    .join("\n");
}

function collapseToOneParagraph(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function firstSentence(text: string): string {
  const collapsed = collapseToOneParagraph(text);
  const m = collapsed.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : collapsed).trim();
}

const BANNER_LINE = /^\s*(?:>|<!--.*-->\s*$)/;

export function peelBanners(input: string): {
  lead: string;
  body: string;
  trail: string;
} {
  const lines = input.split("\n");
  let start = 0;
  let end = lines.length;

  const runEnd = (from: number, step: 1 | -1, limit: number) => {
    let i = from;
    let last = -1;
    while (step === 1 ? i < limit : i > limit) {
      const line = lines[i];
      if (BANNER_LINE.test(line)) last = i;
      else if (line.trim() !== "") break;
      i += step;
    }
    return last;
  };

  const leadEnd = BANNER_LINE.test(lines[0] ?? "")
    ? runEnd(0, 1, lines.length)
    : -1;
  if (leadEnd >= 0) start = leadEnd + 1;

  const lastIdx = lines.length - 1;
  const trailStart =
    lastIdx >= start && BANNER_LINE.test(lines[lastIdx] ?? "")
      ? runEnd(lastIdx, -1, start - 1)
      : -1;
  if (trailStart >= 0) end = trailStart;

  return {
    lead: lines.slice(0, start).join("\n").trim(),
    body: lines.slice(start, end).join("\n").trim(),
    trail: lines.slice(end).join("\n").trim(),
  };
}

export function enforceFormatAsk(args: {
  userMessage: string | null | undefined;
  body: string;
}): { text: string; applied: FormatConstraint | null } {
  const constraint = detectFormatConstraint(args.userMessage);
  if (!constraint) return { text: args.body, applied: null };

  const rawBody = args.body ?? "";
  if (rawBody.trim().length === 0) return { text: rawBody, applied: null };

  const { lead, body, trail } = peelBanners(rawBody);
  if (body.trim().length === 0) return { text: rawBody, applied: null };
  const reattach = (text: string) =>
    (lead ? lead + "\n\n" : "") + text + (trail ? "\n\n" + trail : "");

  const segments = splitFencedCode(body);
  const hasCode = segments.some((s) => s.code);

  let proseStripped = false;
  const stripped = segments.map((s) => {
    if (s.code) return s;
    const next = stripHeadingsFromProse(s.text);
    if (next !== s.text) proseStripped = true;
    return { code: false, text: next };
  });

  const joined = stripped
    .map((s) => s.text)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .trimEnd();

  if (constraint === "no_headings") {
    return {
      text: reattach(joined),
      applied: proseStripped ? "no_headings" : null,
    };
  }

  const hasList = joined.split("\n").some((l) => LIST_LINE.test(l));
  if (hasCode || hasList) {
    const changed = proseStripped || joined !== body;
    return { text: reattach(joined), applied: changed ? constraint : null };
  }

  if (constraint === "one_paragraph") {
    return {
      text: reattach(collapseToOneParagraph(joined)),
      applied: "one_paragraph",
    };
  }
  return { text: reattach(firstSentence(joined)), applied: constraint };
}
