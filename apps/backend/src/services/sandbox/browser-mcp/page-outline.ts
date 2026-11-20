
import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

export const OUTLINE_DEFAULT_CHARS = 8_000;
export const OUTLINE_MAX_CHARS = 16_000;
export const OUTLINE_MAX_HTML_BYTES = 2_000_000;
const MAX_HEADINGS = 40;
const MAX_LINKS = 80;
const MAX_HEADING_CHARS = 160;
const MAX_LINK_TEXT_CHARS = 100;
const MAX_HREF_CHARS = 300;

const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "head",
]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4"]);
const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "nav", "li",
  "ul", "ol", "tr", "table", "h1", "h2", "h3", "h4", "h5", "h6", "br", "form",
  "aside", "blockquote", "dd", "dt", "figcaption",
]);

export type PageOutline = {
  url: string;
  title: string;
  headings: string[];
  text: string;
  links: Array<{ text: string; href: string }>;
  truncated: boolean;
};

function isElement(n: Node): n is Element {
  return typeof (n as Element).tagName === "string";
}

function attr(el: Element, name: string): string | undefined {
  return el.attrs?.find((a) => a.name === name)?.value;
}

function isHidden(el: Element): boolean {
  if (attr(el, "hidden") !== undefined) return true;
  if (attr(el, "aria-hidden") === "true") return true;
  const style = (attr(el, "style") ?? "").replace(/\s+/g, "").toLowerCase();
  return style.includes("display:none") || style.includes("visibility:hidden");
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function textOf(n: Node): string {
  if ((n as DefaultTreeAdapterTypes.TextNode).nodeName === "#text") {
    return (n as DefaultTreeAdapterTypes.TextNode).value;
  }
  if (isElement(n)) {
    if (SKIP_TAGS.has(n.tagName) || isHidden(n)) return "";
  }
  const kids = (n as Element).childNodes ?? [];
  return kids.map(textOf).join(" ");
}

function resolveHref(raw: string, base: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export function buildPageOutline(
  html: string,
  url: string,
  maxChars: number = OUTLINE_DEFAULT_CHARS,
): PageOutline {
  const budget = Math.max(500, Math.min(OUTLINE_MAX_CHARS, Math.floor(maxChars) || OUTLINE_DEFAULT_CHARS));
  const src = (html ?? "").slice(0, OUTLINE_MAX_HTML_BYTES);
  const doc = parse(src);

  let title = "";
  const headings: string[] = [];
  const links: Array<{ text: string; href: string }> = [];
  const seenHrefs = new Set<string>();
  const textParts: string[] = [];

  const walk = (n: Node): void => {
    if ((n as DefaultTreeAdapterTypes.TextNode).nodeName === "#text") {
      const t = (n as DefaultTreeAdapterTypes.TextNode).value;
      if (t.trim()) textParts.push(t);
      return;
    }
    if (isElement(n)) {
      if (n.tagName === "title" || SKIP_TAGS.has(n.tagName) || isHidden(n)) return;
      if (HEADING_TAGS.has(n.tagName) && headings.length < MAX_HEADINGS) {
        const h = collapse(textOf(n));
        if (h) headings.push(`${n.tagName}: ${clip(h, MAX_HEADING_CHARS)}`);
      }
      if (n.tagName === "a" && links.length < MAX_LINKS) {
        const raw = attr(n, "href");
        const href = raw ? resolveHref(raw, url) : null;
        if (href && !seenHrefs.has(href)) {
          seenHrefs.add(href);
          const label = collapse(textOf(n)) || collapse(attr(n, "aria-label") ?? "") || collapse(attr(n, "title") ?? "");
          links.push({ text: clip(label, MAX_LINK_TEXT_CHARS), href: clip(href, MAX_HREF_CHARS) });
        }
      }
      if (BLOCK_TAGS.has(n.tagName)) textParts.push("\n");
    }
    for (const c of (n as Element).childNodes ?? []) walk(c);
    if (isElement(n) && BLOCK_TAGS.has(n.tagName)) textParts.push("\n");
  };
  const findTitle = (n: Node): void => {
    if (title) return;
    if (isElement(n) && n.tagName === "title") {
      title = clip(collapse(((n.childNodes ?? []) as Node[]).map(textOf).join(" ")), 200);
      return;
    }
    for (const c of (n as Element).childNodes ?? []) findTitle(c);
  };
  findTitle(doc as unknown as Node);
  walk(doc as unknown as Node);

  const text = textParts
    .join(" ")
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n[\n ]*/g, "\n")
    .trim();

  const fixed = JSON.stringify({ url, title, headings, links }).length;
  let truncated = src.length < (html ?? "").length;
  let outLinks = links;
  let outHeadings = headings;
  if (fixed > budget * 0.6) {
    while (JSON.stringify({ url, title, headings: outHeadings, links: outLinks }).length > budget * 0.6 && (outLinks.length > 5 || outHeadings.length > 5)) {
      outLinks = outLinks.slice(0, Math.max(5, Math.floor(outLinks.length / 2)));
      outHeadings = outHeadings.slice(0, Math.max(5, Math.floor(outHeadings.length / 2)));
      truncated = true;
    }
  }
  const skeleton = JSON.stringify({ url, title, headings: outHeadings, links: outLinks }).length;
  const textBudget = Math.max(0, budget - skeleton - 40);
  let outText = text;
  if (outText.length > textBudget) {
    outText = `${outText.slice(0, textBudget)} …[truncated]`;
    truncated = true;
  }
  const out: PageOutline = { url, title, headings: outHeadings, text: outText, links: outLinks, truncated };
  for (let i = 0; i < 8; i++) {
    const over = JSON.stringify(out).length - budget;
    if (over <= 0) break;
    out.text = `${out.text.slice(0, Math.max(0, out.text.length - over - 32))} …[truncated]`;
    out.truncated = true;
  }
  return out;
}
