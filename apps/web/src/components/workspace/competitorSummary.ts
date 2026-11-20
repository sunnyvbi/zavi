
import type { ReportSource } from "./useCompetitorIntel";

export type SummarySegment =
  | { kind: "text"; text: string; bold: boolean }
  | { kind: "cite"; n: number; url: string; title: string; bold: boolean };

export type SummaryLine = {
  lead: boolean;
  segments: SummarySegment[];
};

const CITE_RE = /\[(\d{1,3})\]/g;

const LEAD_RE = /\bmy read\b/i;

function splitSentences(prose: string): string[] {
  const trimmed = prose.trim();
  if (!trimmed) return [];
  const out: string[] = [];
  let start = 0;
  const re = /([.!?])(?<!(?:\s|\()\d\.)(?<!(?:\s|\()\d\d\.)\s+(?=\**[A-Z$(0-9"])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    const end = m.index + 1;
    const piece = trimmed.slice(start, end).trim();
    if (piece) out.push(piece);
    start = re.lastIndex;
  }
  const tail = trimmed.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function segmentize(
  sentence: string,
  byN: Map<number, ReportSource>,
  boldRef: { on: boolean },
): SummarySegment[] {
  const segs: SummarySegment[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      segs.push({ kind: "text", text: buf, bold: boldRef.on });
      buf = "";
    }
  };
  for (let i = 0; i < sentence.length; ) {
    if (sentence.startsWith("**", i)) {
      flush();
      boldRef.on = !boldRef.on;
      i += 2;
      continue;
    }
    CITE_RE.lastIndex = i;
    const cm = CITE_RE.exec(sentence);
    if (cm && cm.index === i) {
      const n = Number(cm[1]);
      const src = byN.get(n);
      if (src) {
        flush();
        segs.push({ kind: "cite", n, url: src.url, title: src.title, bold: boldRef.on });
        i += cm[0].length;
        continue;
      }
    }
    buf += sentence[i];
    i += 1;
  }
  flush();
  return segs.length > 0
    ? segs
    : [{ kind: "text", text: sentence, bold: boldRef.on }];
}

export function summaryLines(
  prose: string,
  sources: ReportSource[],
): SummaryLine[] {
  const byN = new Map(sources.map((s) => [s.n, s]));
  const boldRef = { on: false };
  return splitSentences(prose).map((sentence) => ({
    lead: LEAD_RE.test(sentence),
    segments: segmentize(sentence, byN, boldRef),
  }));
}

export function sourceDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
