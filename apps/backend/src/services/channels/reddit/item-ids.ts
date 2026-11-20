const ID = String.raw`[tc]\d+(?:'s)?`;
const PAREN = new RegExp(String.raw`\s*\((?:items?\s+)?${ID}(?:\s*(?:,|and|&)\s*${ID})*\)`, "g");
const RUN = new RegExp(String.raw`\b(?:items?\s+)?${ID}(?:\s*(?:,|and|&)\s*${ID})*\b`, "g");

export function stripItemIds(text: string | null | undefined): string | null {
  if (!text || !new RegExp(RUN.source).test(text)) return text ?? null;
  const out = text
    .replace(PAREN, "")
    .replace(RUN, (run) => {
      const ids = run.match(/[tc]\d+/g) ?? [];
      const possessive = run.endsWith("'s") ? "'s" : "";
      if (ids.length > 1) return (ids.every((i) => i.startsWith("c")) ? "these comments" : "these threads") + (possessive && "'");
      return (ids[0]?.startsWith("c") ? "a comment" : "a thread") + possessive;
    })
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/(^|[.!?]\s+)([a-z])/g, (_, lead: string, ch: string) => lead + ch.toUpperCase())
    .trim();
  return out || null;
}
