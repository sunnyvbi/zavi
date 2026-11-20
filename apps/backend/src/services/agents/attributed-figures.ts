
const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+`;

const COUNTED = String.raw`subscribers?|members?|upvotes?|downvotes?|comments?|reviews?|ratings?|followers?|subs|karma|score|points?|stars?|threads?|posts?|views?|plays?|likes?|shares?`;
const FIGURE_THEN_NOUN = new RegExp(String.raw`\b(${NUM})\s*(?:\+|k|m)?\s*(?:${COUNTED})\b`, "gi");
const NOUN_THEN_FIGURE = new RegExp(String.raw`\b(?:${COUNTED})\s*(?:of|:|=|at)?\s*(${NUM})\b`, "gi");

export const digitsOf = (s: string): string => s.replace(/[^0-9]/g, "");

export function sentenceSpans(s: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  const re = /[.!?]+(?=\s|$)|\n+/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const end = m.index + m[0].length;
    spans.push({ start, end });
    start = end;
  }
  if (start < s.length) spans.push({ start, end: s.length });
  return spans;
}

export function attributedFigures(text: string): string[] {
  const out = new Set<string>();
  for (const re of [FIGURE_THEN_NOUN, NOUN_THEN_FIGURE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const raw = (m[1] ?? "").trim().replace(/[.,]$/, "");
      const d = digitsOf(raw);
      if (d.length < 3) continue;
      if (d.length === 4 && Number(d) >= 1900 && Number(d) <= 2100) continue;
      out.add(raw);
    }
  }
  return [...out];
}

export function cutSentencesWithFigures(text: string, figures: string[]): string {
  if (figures.length === 0) return text;
  let out = text;
  for (let guard = 0; guard < 100; guard += 1) {
    const spans = sentenceSpans(out);
    const hit = spans.find((sp) => {
      const s = out.slice(sp.start, sp.end);
      return figures.some((f) => s.includes(f));
    });
    if (!hit) break;
    out = out.slice(0, hit.start) + out.slice(hit.end);
  }
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,;:!?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \t]+|[ \t]+$/gm, "");
}

export function normalisePhrase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9']+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PUBLICATION_CLAIM =
  /\b(?:published|publishes|posted|wrote|page titled|live and indexed|already covers)\b/i;
const QUOTED = /["\u201c]([^"\u201d]{12,160})["\u201d]/g;

export function unreadPublicationTitles(text: string, corpus: string): string[] {
  const hay = normalisePhrase(corpus);
  const out = new Set<string>();
  for (const span of sentenceSpans(text)) {
    const sentence = text.slice(span.start, span.end);
    if (!PUBLICATION_CLAIM.test(sentence)) continue;
    QUOTED.lastIndex = 0;
    for (const m of sentence.matchAll(QUOTED)) {
      const title = (m[1] ?? "").trim();
      const norm = normalisePhrase(title);
      if (norm.split(" ").length < 3) continue;
      if (hay.includes(norm)) continue;
      out.add(title);
    }
  }
  return [...out];
}
