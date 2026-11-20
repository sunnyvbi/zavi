
export type Span =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; text: string }
  | { kind: "strong"; spans: Span[] };

export type Block =
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "list"; ordered: boolean; start: number; items: Span[][] };

const BULLET = /^ {0,3}[-*][ \t]+(\S.*)$/;
const NUMBER = /^ {0,3}(\d{1,9})[.)][ \t]+(\S.*)$/;

export function parseMarkup(source: string): Block[] {
  const blocks: Block[] = [];
  const para: string[] = [];
  let list: { ordered: boolean; start: number; items: Span[][] } | null = null;

  const flushPara = (): void => {
    if (para.length === 0) return;
    while (para.length > 0 && para[0].trim() === "") para.shift();
    while (para.length > 0 && para[para.length - 1].trim() === "") para.pop();
    const text = para.join("\n");
    para.length = 0;
    if (text === "") return;
    blocks.push({ kind: "paragraph", spans: parseInline(text) });
  };
  const flushList = (): void => {
    if (!list) return;
    blocks.push({ kind: "list", ordered: list.ordered, start: list.start, items: list.items });
    list = null;
  };

  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const bullet = BULLET.exec(raw);
    const numbered = bullet ? null : NUMBER.exec(raw);
    if (!bullet && !numbered) {
      flushList();
      para.push(raw);
      continue;
    }
    flushPara();
    const ordered = numbered !== null;
    const content = bullet ? bullet[1] : (numbered as RegExpExecArray)[2];
    if (list && list.ordered !== ordered) flushList();
    if (!list) {
      list = {
        ordered,
        start: numbered ? Number.parseInt(numbered[1], 10) : 1,
        items: [],
      };
    }
    list.items.push(parseInline(content));
  }

  flushPara();
  flushList();
  return blocks;
}

const MAX_INLINE_CHARS = 40_000;

function parseInline(text: string): Span[] {
  if (text.length > MAX_INLINE_CHARS) return [{ kind: "text", text }];
  const out: Span[] = [];
  let buf = "";
  let i = 0;

  const flush = (): void => {
    if (buf !== "") {
      out.push({ kind: "text", text: buf });
      buf = "";
    }
  };

  while (i < text.length) {
    const c = text[i];

    if (c === "`") {
      const end = codeEnd(text, i);
      if (end > i + 1) {
        flush();
        out.push({ kind: "code", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (c === "[") {
      const link = matchLabelledLink(text, i);
      if (link) {
        flush();
        out.push({ kind: "link", href: link.href, text: link.text });
        i = link.next;
        continue;
      }
      const refused = LABELLED.exec(text.slice(i));
      if (refused) {
        buf += refused[0];
        i += refused[0].length;
        continue;
      }
    }

    if ((c === "h" || c === "H") && !isWordChar(text[i - 1])) {
      const bare = matchBareUrl(text, i);
      if (bare) {
        flush();
        out.push({ kind: "link", href: bare.href, text: bare.href });
        i = bare.next;
        continue;
      }
    }

    if ((c === "*" || c === "_") && text[i + 1] === c) {
      const strong = matchStrong(text, i, c);
      if (strong) {
        flush();
        out.push({ kind: "strong", spans: parseInline(strong.inner) });
        i = strong.next;
        continue;
      }
    }

    buf += c;
    i += 1;
  }

  flush();
  return out;
}

function codeEnd(text: string, open: number): number {
  for (let j = open + 1; j < text.length; j += 1) {
    if (text[j] === "\n") return -1;
    if (text[j] === "`") return j;
  }
  return -1;
}

const LABELLED = /^\[([^\]\n]+)\]\(([^)\s]+)\)/;

function matchLabelledLink(
  text: string,
  at: number,
): { href: string; text: string; next: number } | null {
  const m = LABELLED.exec(text.slice(at));
  if (!m) return null;
  const href = safeHref(m[2]);
  if (!href) return null;
  if (!labelAgreesWithHref(m[1], href)) return null;
  return { href, text: m[1], next: at + m[0].length };
}

function labelAgreesWithHref(label: string, href: string): boolean {
  const claim = label.trim();
  if (!/^https?:\/\//i.test(claim)) return true;
  try {
    return new URL(claim).host === new URL(href).host;
  } catch {
    return false;
  }
}

const BARE = /^https?:\/\/[^\s<>"'`]+/i;

function matchBareUrl(text: string, at: number): { href: string; next: number } | null {
  const m = BARE.exec(text.slice(at));
  if (!m) return null;
  let url = m[0];
  for (;;) {
    const last = url[url.length - 1];
    if (".,;:!?".includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ")" && count(url, ")") > count(url, "(")) {
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  const href = safeHref(url);
  if (!href) return null;
  return { href, next: at + url.length };
}

function matchStrong(
  text: string,
  at: number,
  ch: string,
): { inner: string; next: number } | null {
  const open = at + 2;
  if (open >= text.length) return null;
  if (isSpace(text[open])) return null;
  if (ch === "_" && isWordChar(text[at - 1])) return null;

  for (let j = open + 1; j + 1 < text.length; j += 1) {
    if (text[j] !== ch || text[j + 1] !== ch) continue;
    if (isSpace(text[j - 1])) continue;
    if (ch === "_" && isWordChar(text[j + 2])) continue;
    return { inner: text.slice(open, j), next: j + 2 };
  }
  return null;
}

function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return url;
}

function isSpace(c: string | undefined): boolean {
  return c === undefined || c === " " || c === "\t" || c === "\n";
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_]/.test(c);
}

function count(s: string, c: string): number {
  let n = 0;
  for (const ch of s) if (ch === c) n += 1;
  return n;
}
