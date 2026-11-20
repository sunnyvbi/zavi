import ts from "typescript";
import { parse, parseFragment } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { SITE_MIGRATIONS_DIR, SITE_REPO_DIR, type SiteGateResult, type SiteSandbox } from "./contract";
import { gateSecrets, scrub } from "./site-gate";

const SHA_RE = /^[0-9a-f]{7,40}$/;
const SAFE_PATH_RE = /^[A-Za-z0-9_@][A-Za-z0-9_.@/-]{0,300}$/;
const MAX_LIGHT_FILES = 20;
const MAX_LIGHT_FILE_BYTES = 400_000;
const JSX_COPY_ATTRS = new Set(["className", "alt", "title", "placeholder", "aria-label", "content", "subtitle", "eyebrow", "tagline", "featuredLabel", "label", "caption"]);
const HTML_COPY_ATTRS = new Set(["class", "alt", "title", "placeholder", "aria-label", "content"]);
const CLASS_ATTRS = new Set(["className", "class"]);
const RAW_TEXT_TAGS = new Set(["script", "style", "noscript", "template"]);
const LITERAL_ATTR_DENY = new Set(["href", "src", "srcSet", "to", "id", "key", "type", "name", "rel", "target", "role", "htmlFor", "method", "action", "lang", "dir", "as", "variant", "size", "slot", "form", "pattern", "accept", "autoComplete", "inputMode", "loading", "decoding", "referrerPolicy", "crossOrigin", "data-testid", "className", "class", "style", "value", "defaultValue"]);
export const SITE_PREVIEW_COOKIE = "__zavi_preview";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ASSETS = 40;
const REASON_MAX = 400;
const TOKEN_SHOWN_MAX = 80;

export type SiteChangeLight = { ok: true; tokens: string[]; styles?: boolean; colors_only?: boolean } | { ok: false; reason: string };
export type SiteChange = { files: number; migrations_touched: boolean; light: SiteChangeLight };

type Copy = { shape: string; texts: string[]; classes: string[]; attrs: string[]; classLists: string[][] };

const COPY_META_RE = /^(description|og:(?!image|url).+|twitter:(?!image).+)$/i;

export type SiteLightGateResult = SiteGateResult & { missing_text?: true; infra?: true };

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return parseFragment(s.replace(/</g, "&lt;"))
    .childNodes.map((n) => (n.nodeName === "#text" ? (n as DefaultTreeAdapterTypes.TextNode).value : ""))
    .join("");
}

function unescapeJs(s: string): string {
  return s.replace(/\\(u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|['"`\\/])/g, (_m, e: string) => {
    if (e.startsWith("u{")) return String.fromCodePoint(parseInt(e.slice(2, -1), 16));
    if (e.startsWith("u") || e.startsWith("x")) return String.fromCharCode(parseInt(e.slice(1), 16));
    return e;
  });
}

function normalizeText(s: string): string {
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}

function jsxMetaIsCopy(attr: ts.JsxAttribute, sf: ts.SourceFile): boolean {
  const el = attr.parent.parent;
  if (el.tagName.getText(sf) !== "meta") return false;
  return el.attributes.properties.some(
    (p) => ts.isJsxAttribute(p) && ["name", "property"].includes(p.name.getText(sf)) && COPY_META_RE.test(copyLiteral(p.initializer) ?? ""),
  );
}

function htmlMetaIsCopy(el: DefaultTreeAdapterTypes.Element): boolean {
  return el.tagName === "meta" && el.attrs.some((a) => (a.name === "name" || a.name === "property") && COPY_META_RE.test(a.value));
}

function copyLiteral(init: ts.JsxAttributeValue | undefined): string | null {
  if (!init) return null;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression) {
    const e = init.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  }
  return null;
}

export function literalAttrIsCopy(name: string): boolean {
  return !LITERAL_ATTR_DENY.has(name);
}

export function literalIsCopy(node: ts.Node): boolean {
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return false;
  const p = node.parent;
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p) || ts.isLiteralTypeNode(p)) return false;
  if (ts.isImportTypeNode(p) || ts.isModuleDeclaration(p) || ts.isElementAccessExpression(p) || ts.isJsxAttribute(p)) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) || ts.isEnumMember(p)) && p.name === node) return false;
  if (ts.isCallExpression(p) && (p.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(p.expression) && p.expression.text === "require"))) return false;
  if (ts.isExpressionStatement(p)) return false;
  return true;
}

export function jsxCopyShape(source: string, fileName: string, opts: { literals?: boolean } = {}): Copy {
  const kind = fileName.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.TSX;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const out: string[] = [];
  const texts: string[] = [];
  const classes: string[] = [];
  const attrs: string[] = [];
  const classLists: string[][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      if (node.containsOnlyTriviaWhiteSpaces) return;
      out.push("#text");
      const t = normalizeText(node.text);
      if (t) texts.push(t);
      return;
    }
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      const copy =
        (JSX_COPY_ATTRS.has(name) && (name !== "content" || jsxMetaIsCopy(node, sf))) ||
        (opts.literals === true && literalAttrIsCopy(name) && !!node.initializer && ts.isStringLiteral(node.initializer));
      const value = copy ? copyLiteral(node.initializer) : null;
      if (value !== null) {
        out.push(`@${name}=#v`);
        if (CLASS_ATTRS.has(name)) {
          const list = value.split(/\s+/).filter(Boolean);
          classes.push(...list);
          classLists.push(list);
        } else if (normalizeText(value)) attrs.push(normalizeText(value));
        return;
      }
    }
    if (opts.literals && literalIsCopy(node)) {
      out.push("#lit");
      const t = normalizeText((node as ts.StringLiteral).text.replace(/&/g, "&amp;"));
      if (t) texts.push(t);
      return;
    }
    const children = node.getChildren(sf);
    if (children.length === 0) {
      out.push(`${node.kind}:${node.getText(sf)}`);
      return;
    }
    for (const c of children) visit(c);
  };
  visit(sf);
  return { shape: out.join("\u0000"), texts, classes, attrs, classLists };
}

type HtmlNode = DefaultTreeAdapterTypes.ChildNode | DefaultTreeAdapterTypes.Document;

export function htmlCopyShape(source: string): Copy {
  const doc = parse(source);
  const out: string[] = [];
  const texts: string[] = [];
  const classes: string[] = [];
  const attrs: string[] = [];
  const classLists: string[][] = [];
  const visit = (node: HtmlNode, raw: boolean): void => {
    if (node.nodeName === "#text") {
      const value = (node as DefaultTreeAdapterTypes.TextNode).value;
      if (raw) {
        out.push(`#raw:${value}`);
        return;
      }
      if (!value.trim()) return;
      out.push("#text");
      texts.push(normalizeText(value));
      return;
    }
    if (node.nodeName === "#comment") {
      out.push(`#comment:${(node as DefaultTreeAdapterTypes.CommentNode).data}`);
      return;
    }
    if (node.nodeName === "#documentType") {
      out.push(`#doctype:${(node as DefaultTreeAdapterTypes.DocumentType).name}`);
      return;
    }
    const el = node as DefaultTreeAdapterTypes.Element;
    if (el.tagName) {
      out.push(`<${el.tagName}`);
      for (const a of el.attrs ?? []) {
        if (HTML_COPY_ATTRS.has(a.name) && (a.name !== "content" || htmlMetaIsCopy(el))) {
          out.push(`@${a.name}=#v`);
          if (CLASS_ATTRS.has(a.name)) {
            const list = a.value.split(/\s+/).filter(Boolean);
            classes.push(...list);
            classLists.push(list);
          } else if (normalizeText(a.value)) attrs.push(normalizeText(a.value));
        } else {
          out.push(`@${a.name}=${a.value}`);
        }
      }
    }
    const kids = (node as { childNodes?: DefaultTreeAdapterTypes.ChildNode[] }).childNodes ?? [];
    const content = (el.tagName === "template" ? (el as DefaultTreeAdapterTypes.Template).content?.childNodes : null) ?? [];
    const childRaw = raw || (!!el.tagName && RAW_TEXT_TAGS.has(el.tagName));
    for (const c of [...kids, ...content]) visit(c, childRaw);
    if (el.tagName) out.push(`</${el.tagName}`);
  };
  visit(doc, false);
  return { shape: out.join("\u0000"), texts, classes, attrs, classLists };
}

function newOnes(before: string[], after: string[]): string[] {
  const seen = new Set(before);
  return [...new Set(after)].filter((t) => !seen.has(t));
}

export function compareCopyEdit(
  path: string,
  before: string,
  after: string,
  opts: { literals?: boolean } = {},
): { ok: true; tokens: string[]; styles: boolean; colors_only: boolean } | { ok: false; reason: string } {
  let a: Copy;
  let b: Copy;
  try {
    if (path === "index.html") {
      a = htmlCopyShape(before);
      b = htmlCopyShape(after);
    } else {
      a = jsxCopyShape(before, path, opts);
      b = jsxCopyShape(after, path, opts);
    }
  } catch {
    return { ok: false, reason: `${path} could not be read as markup` };
  }
  if (a.shape !== b.shape) return { ok: false, reason: `${path} changes more than text and style values` };
  const styles = a.classes.join(" ") !== b.classes.join(" ");
  return {
    ok: true,
    tokens: [...newOnes(a.texts, b.texts), ...newOnes(a.classes, b.classes), ...newOnes(a.attrs, b.attrs)],
    styles,
    colors_only:
      styles && a.classLists.length === b.classLists.length && a.classLists.every((list, i) => colorClassSwap(list, b.classLists[i])),
  };
}

const TW_PALETTE =
  "slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const TW_THEME = "background|foreground|primary|secondary|muted|accent|destructive|card|popover|border|input|ring";
const TW_COLOR_VALUE =
  `(?:(?:${TW_PALETTE})-(?:50|[1-9]00|950)|black|white|transparent|current|inherit|(?:${TW_THEME})(?:-foreground)?` +
  String.raw`|\[(?:#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab)\([0-9.,%_/]+\))\])(?:\/(?:\d{1,3}|\[[\d.]+%?\]))?`;
const TW_COLOR_PREFIX =
  "bg|text|border(?:-[xytrblse])?|ring-offset|ring|outline|decoration|divide|placeholder|caret|accent|fill|stroke|shadow|from|via|to";
const TW_COLOR_CLASS_RE = new RegExp(`^((?:[a-z0-9-]+:)*!?(?:${TW_COLOR_PREFIX}))-${TW_COLOR_VALUE}$`);

function colorUtilityKey(cls: string): string | null {
  return TW_COLOR_CLASS_RE.exec(cls)?.[1] ?? null;
}

function without(from: string[], take: string[]): string[] {
  const left = [...take];
  return from.filter((c) => {
    const i = left.indexOf(c);
    if (i === -1) return true;
    left.splice(i, 1);
    return false;
  });
}

function colorClassSwap(before: string[], after: string[]): boolean {
  const removed = without(before, after).map(colorUtilityKey);
  const added = without(after, before).map(colorUtilityKey);
  if (removed.length !== added.length) return false;
  if (removed.some((k) => k === null) || added.some((k) => k === null)) return false;
  return [...removed].sort().join(" ") === [...added].sort().join(" ");
}

const CSS_NAMED_COLORS = [
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black", "blanchedalmond", "blue",
  "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue", "cornsilk",
  "crimson", "cyan", "darkblue", "darkcyan", "darkgoldenrod", "darkgray", "darkgreen", "darkgrey", "darkkhaki",
  "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen", "darkslateblue",
  "darkslategray", "darkslategrey", "darkturquoise", "darkviolet", "deeppink", "deepskyblue", "dimgray", "dimgrey",
  "dodgerblue", "firebrick", "floralwhite", "forestgreen", "fuchsia", "gainsboro", "ghostwhite", "gold", "goldenrod",
  "gray", "green", "greenyellow", "grey", "honeydew", "hotpink", "indianred", "indigo", "ivory", "khaki", "lavender",
  "lavenderblush", "lawngreen", "lemonchiffon", "lightblue", "lightcoral", "lightcyan", "lightgoldenrodyellow",
  "lightgray", "lightgreen", "lightgrey", "lightpink", "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray",
  "lightslategrey", "lightsteelblue", "lightyellow", "lime", "limegreen", "linen", "magenta", "maroon",
  "mediumaquamarine", "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue",
  "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue", "mintcream", "mistyrose", "moccasin",
  "navajowhite", "navy", "oldlace", "olive", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod", "palegreen",
  "paleturquoise", "palevioletred", "papayawhip", "peachpuff", "peru", "pink", "plum", "powderblue", "purple",
  "rebeccapurple", "red", "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown", "seagreen", "seashell",
  "sienna", "silver", "skyblue", "slateblue", "slategray", "slategrey", "snow", "springgreen", "steelblue", "tan", "teal",
  "thistle", "tomato", "transparent", "turquoise", "violet", "wheat", "white", "whitesmoke", "yellow", "yellowgreen",
  "currentcolor",
].join("|");
const CSS_COLOR_TOKEN =
  String.raw`#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])` +
  String.raw`|(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\((?:[^()]|\([^()]*\))*\)` +
  String.raw`|(?<![\w-])(?:` + CSS_NAMED_COLORS + String.raw`)(?![\w-])`;
const CSS_COLOR_TOKEN_RE = new RegExp(CSS_COLOR_TOKEN, "gi");
const CSS_HSL_CHANNELS = String.raw`\d+(?:\.\d+)?(?:deg)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%(?:\s*\/\s*\d*\.?\d+%?)?`;
const CSS_WHOLE_COLOR_RE = new RegExp(`^(?:${CSS_COLOR_TOKEN}|${CSS_HSL_CHANNELS})$`, "i");
const CSS_COLOR_PROP_RE =
  /^(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?|text-decoration(?:-color)?|text-emphasis-color|column-rule(?:-color)?|caret-color|accent-color|fill|stroke|box-shadow|text-shadow|stop-color|flood-color|lighting-color|scrollbar-color|-webkit-text-fill-color|-webkit-text-stroke-color)$/i;
const CSS_LITERAL_PART_RE = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|url\((?:[^()]|\([^()]*\))*\))/i;
const COLOR_MARK = "\u0001";

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function maskColorValue(prop: string, value: string): string {
  const v = squash(value);
  if (prop.startsWith("--")) return CSS_WHOLE_COLOR_RE.test(v) ? COLOR_MARK : v;
  if (!CSS_COLOR_PROP_RE.test(prop)) return v;
  return v
    .split(CSS_LITERAL_PART_RE)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(CSS_COLOR_TOKEN_RE, COLOR_MARK)))
    .join("");
}

function cssColorShape(source: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let parens = 0;
  let buf = "";
  const flush = () => {
    const text = buf.trim();
    buf = "";
    if (!text) return;
    const colon = text.indexOf(":");
    if (depth > 0 && /^@apply\s/.test(text)) {
      out.push(`A:${squash(text.slice("@apply".length))}`);
    } else if (depth > 0 && colon > 0 && !text.startsWith("@")) {
      const prop = text.slice(0, colon).trim();
      out.push(`D:${prop}:${maskColorValue(prop, text.slice(colon + 1))}`);
    } else {
      out.push(`S:${squash(text)}`);
    }
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return null;
      buf += " ";
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        if (source[j] === "\n") return null;
        j += source[j] === "\\" ? 2 : 1;
      }
      if (j >= source.length) return null;
      buf += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "(") parens += 1;
    if (ch === ")") parens -= 1;
    if (parens < 0) return null;
    if (parens === 0 && ch === "{") {
      out.push(`P:${squash(buf)}{`);
      buf = "";
      depth += 1;
    } else if (parens === 0 && ch === "}") {
      flush();
      if (depth === 0) return null;
      depth -= 1;
      out.push("}");
    } else if (parens === 0 && ch === ";") {
      flush();
    } else {
      buf += ch;
    }
    i += 1;
  }
  if (depth !== 0 || parens !== 0) return null;
  flush();
  return out;
}

export function cssColorOnlyChange(before: string, after: string): boolean {
  const a = cssColorShape(before);
  const b = cssColorShape(after);
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    if (x === y) return true;
    if (!x.startsWith("A:") || !y.startsWith("A:")) return false;
    return colorClassSwap(x.slice(2).split(" "), y.slice(2).split(" "));
  });
}

function lightEligible(path: string): boolean {
  return path === "index.html" || path.endsWith(".css") || path.endsWith(".tsx") || path.endsWith(".jsx");
}

function safePath(path: string): boolean {
  return SAFE_PATH_RE.test(path) && !path.split("/").includes("..");
}

async function showFile(sandbox: SiteSandbox, sha: string, path: string): Promise<string | null> {
  const r = await sandbox.run(`git show '${sha}:${path}'`, { cwd: SITE_REPO_DIR, timeoutMs: 60_000 });
  if (r.exitCode !== 0) return null;
  if (r.stdout.length > MAX_LIGHT_FILE_BYTES) return null;
  return r.stdout;
}

export async function classifySiteChange(sandbox: SiteSandbox, live_sha: string, sha: string): Promise<SiteChange | null> {
  if (!SHA_RE.test(live_sha) || !SHA_RE.test(sha)) return null;
  const r = await sandbox.run(`git diff --no-ext-diff --no-color --name-status -M ${live_sha} ${sha}`, {
    cwd: SITE_REPO_DIR,
    timeoutMs: 60_000,
  });
  if (r.exitCode !== 0) return null;
  const entries = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [status, ...paths] = l.split("\t");
      return { status: status ?? "", paths };
    });
  const migrations_touched = entries.some((e) => e.paths.some((p) => p === SITE_MIGRATIONS_DIR || p.startsWith(`${SITE_MIGRATIONS_DIR}/`)));
  const files = entries.length;
  const notLight = (reason: string): SiteChange => ({ files, migrations_touched, light: { ok: false, reason } });
  if (entries.length > MAX_LIGHT_FILES) return notLight(`${entries.length} files changed`);
  const tokens: string[] = [];
  let styles = false;
  let colorsOnly = true;
  for (const e of entries) {
    const path = e.paths[0] ?? "";
    if (e.status !== "M" || e.paths.length !== 1) return notLight(`${path || "a file"} was added, deleted or renamed`);
    if (!safePath(path)) return notLight("a changed file has an unusual name");
    if (!lightEligible(path)) return notLight(`${path} is not a style or markup file`);
    const [before, after] = await Promise.all([showFile(sandbox, live_sha, path), showFile(sandbox, sha, path)]);
    if (path.endsWith(".css")) {
      styles = true;
      if (before === null || after === null || !cssColorOnlyChange(before, after)) colorsOnly = false;
      continue;
    }
    if (before === null || after === null) return notLight(`${path} could not be read`);
    const cmp = compareCopyEdit(path, before, after);
    if (!cmp.ok) return notLight(cmp.reason);
    tokens.push(...cmp.tokens);
    if (cmp.styles) {
      styles = true;
      if (!cmp.colors_only) colorsOnly = false;
    }
  }
  return { files, migrations_touched, light: { ok: true, tokens: [...new Set(tokens)], styles, colors_only: styles && colorsOnly } };
}

export type SiteFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; redirect?: "manual" | "follow"; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null; getSetCookie?: () => string[] };
  text(): Promise<string>;
}>;

export type SiteLightGateInput = {
  preview_url: string;
  tokens: string[];
  fetchFn?: SiteFetch;
  timeoutMs?: number;
};

function assetUrls(html: string, origin: string): string[] {
  const doc = parse(html);
  const urls: string[] = [];
  const visit = (node: HtmlNode): void => {
    const el = node as DefaultTreeAdapterTypes.Element;
    if (el.tagName) {
      const attr = (n: string) => el.attrs.find((a) => a.name === n)?.value ?? null;
      let ref: string | null = null;
      if (el.tagName === "script") ref = attr("src");
      if (el.tagName === "link") {
        const rel = (attr("rel") ?? "").toLowerCase().split(/\s+/);
        if (rel.includes("stylesheet") || rel.includes("modulepreload")) ref = attr("href");
      }
      if (ref) {
        try {
          const u = new URL(ref, `${origin}/`);
          if (u.origin === origin) urls.push(u.toString());
        } catch {
          return;
        }
      }
    }
    for (const c of (node as { childNodes?: DefaultTreeAdapterTypes.ChildNode[] }).childNodes ?? []) visit(c);
  };
  visit(doc);
  return [...new Set(urls)].slice(0, MAX_ASSETS);
}

const CHUNK_REF_RE = /["'`]((?:\.{1,2}\/|\/)?[A-Za-z0-9_./-]+\.(?:js|css))["'`]/g;

function chunkUrls(body: string, from: string, origin: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(CHUNK_REF_RE)) {
    const ref = m[1];
    try {
      const base = ref.startsWith(".") ? from : `${origin}/`;
      const u = new URL(ref, base);
      if (u.origin === origin && u.pathname.startsWith("/assets/")) out.push(u.toString());
    } catch {
      continue;
    }
  }
  return out;
}

function previewCookie(headers: { get(name: string): string | null; getSetCookie?: () => string[] }): string | null {
  const all = headers.getSetCookie?.() ?? [];
  const raw = all.length > 0 ? all : (headers.get("set-cookie") ?? "").split(/,(?=\s*[A-Za-z0-9_.-]+=)/);
  for (const c of raw) {
    const pair = c.trim().split(";")[0]?.trim() ?? "";
    if (pair.startsWith(`${SITE_PREVIEW_COOKIE}=`) && pair.length > SITE_PREVIEW_COOKIE.length + 1) return pair;
  }
  return null;
}

function fail(reason: string, secrets: string[], evidence = ""): SiteGateResult {
  return { ok: false, reason: scrub(reason, secrets).slice(0, REASON_MAX), evidence: scrub(evidence, secrets), owner_journey: "not_required" };
}

function unreachable(reason: string, secrets: string[]): SiteLightGateResult {
  return { ...fail(reason, secrets), infra: true };
}

export async function runSiteLightGate(input: SiteLightGateInput): Promise<SiteLightGateResult> {
  const fetchFn: SiteFetch = input.fetchFn ?? ((globalThis as unknown as { fetch: SiteFetch }).fetch);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const secrets = gateSecrets([input.preview_url]);
  let origin: string;
  try {
    origin = new URL(input.preview_url).origin;
  } catch {
    return fail("the preview link is not a valid address", secrets);
  }
  const get = (url: string, cookie?: string) =>
    fetchFn(url, {
      method: "GET",
      redirect: "manual",
      headers: cookie ? { cookie } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
  let cookie: string | null;
  try {
    const entry = await get(input.preview_url);
    if (entry.status !== 302) return unreachable(`the preview link answered ${entry.status} instead of 302`, secrets);
    cookie = previewCookie(entry.headers);
  } catch (e) {
    return unreachable(`the preview link could not be loaded: ${String((e as Error)?.message ?? e)}`, secrets);
  }
  if (!cookie) return unreachable("the preview link did not set the preview cookie", secrets);
  const allSecrets = gateSecrets([input.preview_url, cookie, cookie.slice(SITE_PREVIEW_COOKIE.length + 1)]);
  let html: string;
  try {
    const home = await get(`${origin}/`, cookie);
    if (home.status !== 200) return unreachable(`the home page answered ${home.status}`, allSecrets);
    if (home.headers.get("x-zavi-preview") !== "1") return unreachable("the home page was not served from the staged preview", allSecrets);
    html = await home.text();
  } catch (e) {
    return unreachable(`the home page could not be loaded: ${String((e as Error)?.message ?? e)}`, allSecrets);
  }
  const assets = assetUrls(html, origin);
  if (!assets.some((u) => new URL(u).pathname.endsWith(".js"))) return fail("the home page loads no script", allSecrets);
  const bodies: string[] = [html];
  const queue = [...assets];
  const seen = new Set(queue);
  const chunks: string[] = [];
  for (const url of queue) {
    const path = new URL(url).pathname;
    try {
      const r = await get(url, cookie);
      if (r.status >= 500 || r.status === 429) return unreachable(`${path} answered ${r.status}`, allSecrets);
      if (r.status !== 200) return fail(`${path} answered ${r.status}`, allSecrets);
      const body = await r.text();
      bodies.push(body);
      if (path.endsWith(".js")) {
        for (const c of chunkUrls(body, url, origin)) {
          if (!seen.has(c)) {
            seen.add(c);
            chunks.push(c);
          }
        }
      }
    } catch (e) {
      return unreachable(`${path} could not be loaded: ${String((e as Error)?.message ?? e)}`, allSecrets);
    }
  }
  for (const url of chunks.slice(0, MAX_ASSETS)) {
    try {
      const r = await get(url, cookie);
      if (r.status === 200) bodies.push(await r.text());
    } catch {
      continue;
    }
  }
  const haystack = normalizeText(unescapeJs(bodies.join("\n")));
  const tokens = [...new Set(input.tokens.map(normalizeText).filter(Boolean))];
  const missing = tokens.find((t) => !haystack.includes(t));
  const evidence = JSON.stringify({ gate: "light", assets: assets.length, tokens: tokens.length });
  if (missing !== undefined) {
    const shown = missing.length > TOKEN_SHOWN_MAX ? `${missing.slice(0, TOKEN_SHOWN_MAX)}…` : missing;
    return { ...fail(`the new text "${shown}" is not in the published page`, allSecrets, evidence), missing_text: true };
  }
  return { ok: true, reason: "light check passed", evidence, owner_journey: "not_required" };
}
