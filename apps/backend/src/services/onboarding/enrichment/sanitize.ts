
import { AI_BOTS } from "@/services/tools/growth/geo/bots";

const ROBOTS_UA_TOKENS = ["\\*", ...AI_BOTS.map((b) => b.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))].join("|");

const INJECTION_PATTERNS: RegExp[] = [
  new RegExp(
    `^\\s*(\\[)?(system|user(?!-agent:[ \\t]*(?:${ROBOTS_UA_TOKENS})[ \\t]*$)|assistant)(\\])?\\s*[:\\-]`,
    "gim",
  ),
  /^#{1,6}\s*(system|assistant|developer)\s*[:\-]/gim,
  /\bignore\s+(the\s+|all\s+|previous\s+|above\s+|prior\s+)*\b(instructions?|prompt|messages?|rules?|directives?)\b/gi,
  /\b(the\s+user|the\s+admin|the\s+founder)\s+(has\s+)?(approved|authorized|confirmed|requested)\b/gi,
  /^\s*assistant\s*:\s*(i\s+will|here\s+is|sure[,\s]|of\s+course)/gim,
  /<<<\s*[A-Z_]+/g,
  /<\/?\s*(system|assistant|user)\s*>/gi,
];

const STRIPPED_BLOCKS: Array<[open: RegExp, close: RegExp]> = [
  [/<script\b/gi, /<\/script>/gi],
  [/<style\b/gi, /<\/style>/gi],
  [/<!--/g, /-->/g],
  [/<svg\b/gi, /<\/svg>/gi],
  [/<noscript\b/gi, /<\/noscript>/gi],
  [/<template\b/gi, /<\/template>/gi],
];
const ROLE_BLOCKS: Array<[open: RegExp, close: RegExp]> = [
  [/<system\b/gi, /<\/system>/gi],
  [/<assistant\b/gi, /<\/assistant>/gi],
  [/<user\b/gi, /<\/user>/gi],
];

function removeBlocks(
  s: string,
  open: RegExp,
  close: RegExp,
  replacement: string,
  dropUnclosedTail = false,
): string {
  let out = "";
  let pos = 0;
  for (;;) {
    open.lastIndex = pos;
    const o = open.exec(s);
    if (!o) break;
    close.lastIndex = o.index + o[0].length;
    const c = close.exec(s);
    if (!c) {
      if (!dropUnclosedTail) break;
      out += s.slice(pos, o.index) + replacement;
      pos = s.length;
      break;
    }
    out += s.slice(pos, o.index) + replacement;
    pos = c.index + c[0].length;
  }
  return pos === 0 ? s : out + s.slice(pos);
}
const LONE_ROLE_TAG = /<\/?\s*(system|assistant|user)\s*\/?>/gi;
const INLINE_HANDLERS = /\s+on[a-z]+\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+)/gi;
const DATA_URI_ATTR = /\b(href|src)\s*=\s*("|')?\s*(data|javascript|vbscript):[^"'>\s]+("|')?/gi;
const BASE64_BLOB = /[A-Za-z0-9+/=]{200,}/g;
const DANGLING_TAG = /^<\/?[a-zA-Z][\w-]*(?:\s[^>]*=[^>]*)?$/;
const BOILERPLATE: RegExp[] = [/\bskip to (main )?content\b/gi, /\btranslation missing:\s*[\w.-]+/gi];
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
};

const isTagStart = (ch: string | undefined): boolean => !!ch && /[a-zA-Z!/?]/.test(ch);

export function stripTags(s: string): string {
  let out = "";
  let i = 0;
  let quoteAware = true;
  const n = s.length;
  while (i < n) {
    const lt = s.indexOf("<", i);
    if (lt === -1) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, lt);
    if (!isTagStart(s[lt + 1])) {
      out += "<";
      i = lt + 1;
      continue;
    }
    let j = lt + 1;
    let quote = "";
    let end = -1;
    let abortAt = -1;
    for (; j < n; j++) {
      const ch = s[j];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === ">") {
        end = j;
        break;
      } else if (ch === "<") {
        abortAt = j;
        break;
      } else if (quoteAware && (ch === '"' || ch === "'")) {
        quote = ch;
      }
    }
    if (end !== -1) {
      out += " ";
      i = end + 1;
    } else if (abortAt !== -1) {
      out += " ";
      i = abortAt;
    } else if (quote) {
      quoteAware = false;
      i = lt;
    } else {
      const tail = s.slice(lt);
      out += DANGLING_TAG.test(tail) ? " " : tail;
      break;
    }
  }
  return out;
}

export function decodeHtmlEntities(s: string): string {
  if (!s) return "";
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (m, ent: string) => {
    if (ent[0] === "#") {
      const hex = ent[1] === "x" || ent[1] === "X";
      const code = hex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      return code === 0xa0 ? " " : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? m;
  });
}
const UNICODE_BIDI = /[‪-‮⁦-⁩]/g;
const MAX_DECODE_PASSES = 3;

function normalizeWhitespace(s: string): string {
  return s.replace(/[^\S\n]+/g, " ").replace(/\n\s*/g, "\n");
}

export function sanitizeFetchedContent(html: string): string {
  if (!html) return "";
  let s = html;
  s = normalizeWhitespace(s);
  for (const [open, close] of STRIPPED_BLOCKS) {
    const isScriptOrStyle = open.source === "<script\\b" || open.source === "<style\\b";
    s = removeBlocks(s, open, close, " ", isScriptOrStyle);
  }
  s = normalizeWhitespace(s);
  for (const [open, close] of ROLE_BLOCKS) {
    s = removeBlocks(s, open, close, " [redacted-injection-pattern] ");
  }
  s = s.replace(LONE_ROLE_TAG, " [redacted-injection-pattern] ");
  s = s.replace(INLINE_HANDLERS, " ");
  s = s.replace(DATA_URI_ATTR, " ");
  s = s.replace(BASE64_BLOB, " [base64-blob-redacted] ");
  s = stripTags(s);
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    const next = decodeHtmlEntities(s);
    if (next === s) break;
    s = next;
  }
  s = normalizeWhitespace(s);
  s = s.replace(UNICODE_BIDI, "");
  for (const [open, close] of ROLE_BLOCKS) {
    s = removeBlocks(s, open, close, " [redacted-injection-pattern] ");
  }
  for (const re of INJECTION_PATTERNS) {
    s = s.replace(re, " [redacted-injection-pattern] ");
  }
  s = stripTags(s);
  for (const re of INJECTION_PATTERNS) {
    s = s.replace(re, " [redacted-injection-pattern] ");
  }
  for (const re of BOILERPLATE) s = s.replace(re, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

const DELIMITER_STRINGS: Array<[string, string]> = [
  ["<enrichment>", "&lt;enrichment&gt;"],
  ["</enrichment>", "&lt;/enrichment&gt;"],
  ["<page>", "&lt;page&gt;"],
  ["</page>", "&lt;/page&gt;"],
  ["<app_listing>", "&lt;app_listing&gt;"],
  ["</app_listing>", "&lt;/app_listing&gt;"],
];

const XML_BASIC_ESCAPES: Array<[string, string]> = [
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&apos;"],
];

export function xmlEscapeContent(text: string): string {
  if (!text) return "";
  let s = text;
  for (const [from, to] of XML_BASIC_ESCAPES) {
    s = s.split(from).join(to);
  }
  for (const [from, to] of DELIMITER_STRINGS) {
    s = s.split(from).join(to);
  }
  return s;
}

export function decodeXmlEntities(text: string): string {
  if (!text) return "";
  let cur = text;
  for (let i = 0; i < 32; i++) {
    const next = cur
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&#39;/gi, "'")
      .replace(/&amp;/gi, "&");
    if (next === cur) break;
    cur = next;
  }
  return cur;
}
