
const CLOSING = /^(regards|best regards|kind regards|warm regards|best|best wishes|thanks|thank you|thanks again|many thanks|cheers|sincerely|yours|yours truly|talk soon|take care)[,.!]?$/i;
const DEVICE = /^(sent from my \S.*|sent from (outlook|mail) for \S.*|get outlook for \S.*)$/i;
const NAME = /^[A-Z][A-Za-z.'-]*(\s+[A-Z][A-Za-z.'-]*){0,3}$/;
const MAX_NAME_LINES = 2;

export function stripSignoff(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let end = lines.length;
  for (let i = end - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (!t) continue;
    if (DEVICE.test(t)) end = i;
    break;
  }
  for (let i = end - 1, seen = 0; i >= 0 && seen <= MAX_NAME_LINES; i--) {
    const t = lines[i]!.trim();
    if (!t) continue;
    seen += 1;
    if (!CLOSING.test(t)) continue;
    const after = lines.slice(i + 1, end).map((l) => l.trim()).filter(Boolean);
    const before = lines.slice(0, i).map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
    if (after.every((l) => NAME.test(l)) && !before.endsWith(":")) end = i;
    break;
  }
  const kept = lines.slice(0, end).join("\n").trim();
  return kept || text.trim();
}
