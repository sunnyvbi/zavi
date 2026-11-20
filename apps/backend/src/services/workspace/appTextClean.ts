
const LEADING_COMMAND_TAG = /^\s*\[[a-z][a-z0-9_-]*\]\s*/i;

const ENTITIES: Record<string, string> = {
  "&gt;": ">",
  "&lt;": "<",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(s: string): string {
  let out = s;
  for (let pass = 0; pass < 3; pass += 1) {
    const before = out;
    for (const [ent, ch] of Object.entries(ENTITIES)) {
      out = out.split(ent).join(ch);
    }
    out = out.split("&amp;").join("&");
    if (out === before) break;
  }
  return out;
}

function stripMarkdownMarkers(s: string): string {
  return (
    s
      .replace(/^\s{0,3}#{1,6}\s*/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/\*\*(.+?)\*\*/gs, "$1")
      .replace(/__(.+?)__/gs, "$1")
      .replace(/(^|[^*])\*([^*]+?)\*/gs, "$1$2")
      .replace(/`([^`]+?)`/gs, "$1")
  );
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const TRAILING_SEPARATOR = /[\s—–:;,\-–—]+$/;

export function looksLikeBuildPlan(decoded: string | null | undefined): boolean {
  if (typeof decoded !== "string" || decoded.length === 0) return false;

  if (
    /approved plan\b/i.test(decoded) ||
    /copy (?:everything|the prompt) below/i.test(decoded) ||
    /acceptance criteria/i.test(decoded) ||
    /(?:^|\n)[ \t]*(?:\[[a-z][a-z0-9_-]*\][ \t]*)?#{1,6}[ \t]*build prompt\b/i.test(
      decoded,
    )
  ) {
    return true;
  }

  const headings = decoded.match(/^\s{0,3}#{1,6}\s+\S/gm);
  return (headings?.length ?? 0) >= 2;
}

export function cleanAppTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = decodeEntities(raw);
  s = s.replace(LEADING_COMMAND_TAG, "");
  s = stripMarkdownMarkers(s);
  s = collapse(s).replace(TRAILING_SEPARATOR, "");
  return s.length > 0 ? s : null;
}

export function cleanAppDescription(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const decoded = decodeEntities(raw);
  if (looksLikeBuildPlan(decoded)) return null;
  let s = decoded.replace(LEADING_COMMAND_TAG, "");
  s = stripMarkdownMarkers(s);
  s = collapse(s);
  return s.length > 0 ? s : null;
}
