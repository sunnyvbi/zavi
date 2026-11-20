
import { parse, serialize } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";

type Node = DefaultTreeAdapterTypes.Node;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type Element = DefaultTreeAdapterTypes.Element;
type TextNode = DefaultTreeAdapterTypes.TextNode;
type CommentNode = DefaultTreeAdapterTypes.CommentNode;

export interface ScrubStats {
  textNodesStripped: number;
  attrsStripped: number;
  bytesIn: number;
  bytesOut: number;
}

export interface ScrubResult {
  html: string;
  stats: ScrubStats;
}

export const MAX_OUTPUT_BYTES = 256 * 1024;

const MAX_ATTR_VALUE_LEN = 256;

const KEEP_ATTRS: ReadonlySet<string> = new Set([
  "class", "id", "role", "type", "name", "for", "slot", "part", "is", "lang", "dir",
  "disabled", "checked", "selected", "readonly", "required", "multiple", "open",
  "hidden", "tabindex", "contenteditable", "draggable", "spellcheck",
  "method", "enctype", "autocomplete", "inputmode", "pattern", "list", "form",
  "maxlength", "minlength", "min", "max", "step", "wrap", "accept", "capture",
  "novalidate", "formmethod", "formnovalidate", "formenctype",
  "colspan", "rowspan", "headers", "scope", "span", "start", "reversed",
  "width", "height", "size", "cols", "rows", "sizes", "loading", "decoding",
  "controls", "autoplay", "loop", "muted", "playsinline", "preload",
  "target", "rel", "download", "media", "as", "crossorigin", "referrerpolicy",
  "style",
]);

const KEEP_PREFIXES: readonly string[] = ["data-", "aria-"];

const URL_ATTRS: ReadonlySet<string> = new Set([
  "href", "src", "action", "formaction", "poster", "cite", "data",
  "background", "longdesc", "usemap", "xlink:href", "srcset",
]);

const EMPTY_BODY_TAGS: ReadonlySet<string> = new Set(["script", "style"]);

const WHITESPACE_ONLY = /^\s*$/;

function isElement(n: Node): n is Element {
  return typeof (n as Element).tagName === "string";
}
function isText(n: Node): n is TextNode {
  return n.nodeName === "#text";
}
function isComment(n: Node): n is CommentNode {
  return n.nodeName === "#comment";
}
function hasChildNodes(n: Node): n is ParentNode {
  return Array.isArray((n as ParentNode).childNodes);
}

function sanitizeUrlValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== "http" && scheme !== "https") return null;
  }
  let end = trimmed.length;
  const q = trimmed.indexOf("?");
  if (q !== -1) end = Math.min(end, q);
  const h = trimmed.indexOf("#");
  if (h !== -1) end = Math.min(end, h);
  const cut = trimmed.slice(0, end);
  return cut === "" ? null : cut.slice(0, MAX_ATTR_VALUE_LEN);
}

function sanitizeSrcset(raw: string): string | null {
  const parts = raw.split(",");
  const kept: string[] = [];
  for (const part of parts) {
    const seg = part.trim();
    if (seg === "") continue;
    const sp = seg.search(/\s/);
    const url = sp === -1 ? seg : seg.slice(0, sp);
    const descriptor = sp === -1 ? "" : seg.slice(sp);
    const safe = sanitizeUrlValue(url);
    if (safe) kept.push(descriptor ? `${safe}${descriptor}` : safe);
  }
  return kept.length ? kept.join(", ").slice(0, MAX_ATTR_VALUE_LEN) : null;
}

function sanitizeStyleValue(raw: string): string {
  return raw
    .replace(/url\(\s*(['"]?)[^)]*\1\s*\)/gi, "url($1$1)")
    .slice(0, MAX_ATTR_VALUE_LEN);
}

interface AttrDecision {
  keep: boolean;
  value?: string;
}

function decideAttr(name: string, value: string): AttrDecision {
  const lower = name.toLowerCase();

  if (KEEP_PREFIXES.some((p) => lower.startsWith(p))) {
    return { keep: true, value: value.slice(0, MAX_ATTR_VALUE_LEN) };
  }
  if (URL_ATTRS.has(lower)) {
    const safe = lower === "srcset" ? sanitizeSrcset(value) : sanitizeUrlValue(value);
    return safe === null ? { keep: false } : { keep: true, value: safe };
  }
  if (KEEP_ATTRS.has(lower)) {
    const v = lower === "style" ? sanitizeStyleValue(value) : value.slice(0, MAX_ATTR_VALUE_LEN);
    return { keep: true, value: v };
  }
  return { keep: false };
}

function scrubElementAttrs(el: Element, stats: ScrubStats): void {
  const kept: Element["attrs"] = [];
  for (const attr of el.attrs) {
    const decision = decideAttr(attr.name, attr.value);
    if (decision.keep) {
      if (decision.value !== undefined) attr.value = decision.value;
      kept.push(attr);
    } else {
      stats.attrsStripped++;
    }
  }
  el.attrs = kept;
}

function textPlaceholder(len: number): string {
  return `«text:${len}»`;
}

function scrubChildren(parent: ParentNode, stats: ScrubStats): void {
  const out: ChildNode[] = [];
  for (const child of parent.childNodes) {
    if (isComment(child)) {
      continue;
    }
    if (isText(child)) {
      if (WHITESPACE_ONLY.test(child.value)) {
        out.push(child);
      } else {
        const n = child.value.trim().length;
        child.value = textPlaceholder(n);
        stats.textNodesStripped++;
        out.push(child);
      }
      continue;
    }
    if (isElement(child)) {
      scrubElementAttrs(child, stats);
      const tag = child.tagName.toLowerCase();
      if (EMPTY_BODY_TAGS.has(tag)) {
        if (child.childNodes.length > 0) {
          stats.textNodesStripped += child.childNodes.filter(isText).length;
        }
        child.childNodes = [];
      } else {
        scrubChildren(child, stats);
        const tmpl = child as Partial<DefaultTreeAdapterTypes.Template>;
        if (tmpl.content && Array.isArray(tmpl.content.childNodes)) {
          scrubChildren(tmpl.content, stats);
        }
      }
      out.push(child);
      continue;
    }
    out.push(child);
  }
  parent.childNodes = out;
}

function truncateToBytes(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(str.slice(0, mid), "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return str.slice(0, lo);
}

export function scrubDom(html: string): ScrubResult {
  const bytesIn = Buffer.byteLength(html ?? "", "utf8");
  const stats: ScrubStats = { textNodesStripped: 0, attrsStripped: 0, bytesIn, bytesOut: 0 };

  const doc = parse(html ?? "");
  scrubChildren(doc, stats);

  let out = serialize(doc);
  if (Buffer.byteLength(out, "utf8") > MAX_OUTPUT_BYTES) {
    const marker = "<!--[scrub:truncated]-->";
    const budget = MAX_OUTPUT_BYTES - Buffer.byteLength(marker, "utf8");
    out = truncateToBytes(out, budget) + marker;
  }
  stats.bytesOut = Buffer.byteLength(out, "utf8");
  return { html: out, stats };
}
