export type InlineSegment = { text: string; href?: string };

const HREF = String.raw`https?:\/\/(?:[^\s<>()[\]\x60]|\([^\s<>()[\]\x60]*\))+`;
const LINK = new RegExp(String.raw`\[([^\]\n]+)\]\((${HREF})\)|(${HREF})`, "g");
const TRAILING = /[.,;:!?'"*]+$/;

export function splitLinks(text: string): InlineSegment[] {
  const out: InlineSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    const start = m.index ?? 0;
    if (m[1] !== undefined && text[start - 1] === "!") continue;
    let raw = m[0];
    let seg: InlineSegment;
    if (m[1] !== undefined) {
      seg = { text: m[1], href: m[2] };
    } else {
      const trail = TRAILING.exec(raw)?.[0] ?? "";
      raw = raw.slice(0, raw.length - trail.length);
      seg = { text: raw, href: raw };
    }
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push(seg);
    last = start + raw.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
