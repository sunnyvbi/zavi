import ts from "typescript";
import { getBoolSetting } from "@/services/settings";
import { isSiteEditSize, type SiteEditSize } from "./site-edit-route";

export type AdherenceScope = SiteEditSize | "first_build";
export type AdherenceIntent = { scope: AdherenceScope; redesign: boolean; founderStyleRequest?: string };
export type AdherenceFile = { path: string; action: "create" | "modify" | "delete"; before: string | null; after: string | null };
export type FindingKind = "raw_color" | "font_change" | "spacing_drift" | "structure_drift";
export type DesignFinding = {
  kind: FindingKind;
  file: string;
  line?: number;
  evidence: string;
  severity: "info" | "warn";
  exception?: string;
};
export type AdherenceReport = {
  findings: DesignFinding[];
  warn: Record<FindingKind, number>;
  info: number;
  checked: number;
  skipped: string[];
};

export const MAX_ADHERENCE_FILE_BYTES = 400_000;
export const MAX_ADHERENCE_FILES = 60;
export const SPACING_DRIFT_MIN = 3;

const TW_HUES = "slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const COLOR_PREFIX = "bg|text|border(?:-[xytrblse])?|ring-offset|ring|outline|decoration|divide|placeholder|caret|accent|fill|stroke|shadow|from|via|to";
const RAW_COLOR_CLASS_RE = new RegExp(
  `^(?:[a-z0-9-]+:)*!?(${COLOR_PREFIX})-(?:(${TW_HUES})-(50|[1-9]00|950)|(black|white)|\\[(#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab)\\([^\\]]*\\))\\])(\\/(?:\\d{1,3}|\\[[\\d.]+%?\\]))?$`,
);
const OVERLAY_CLASS_RE = /^(?:absolute|inset-0|inset-[xy]-0|bg-gradient-to-[a-z]+|bg-linear-to-[a-z]+|bg-gradient-[a-z-]+|pointer-events-none|mix-blend-[a-z-]+)$/;
const SCRIM_HUE_RE = /^(?:black|white|(?:slate|gray|grey|zinc|neutral|stone)-(?:700|800|900|950))$/;
const ARBITRARY_SPACING_RE = /^(?:[a-z0-9-]+:)*-?(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy])-\[(?!var\()[^\]]+\]$/;
const SECTION_MARGIN_RE = /^(?:[a-z0-9-]+:)*-?(?:m|my|mt|mb)-(?!0$)[a-z0-9.[\]-]+$/;
const ROOT_RHYTHM_RE = /^(?:[a-z0-9-]+:)*(?:space-y|gap-y|gap)-(?!0$)[a-z0-9.[\]-]+$/;
const FONT_CLASS_RE = /^(?:[a-z0-9-]+:)*font-\[(?!\d+\])[^\]]+\]$/;
const HEX_LITERAL_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const COLOR_LITERAL_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[\d.]/i;
const STYLE_NAMED_COLOR_RE = /(?<![\w-])(?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|brown|navy|teal|maroon|olive|silver|gold|crimson|tomato|coral|salmon|beige|ivory)(?![\w-])/i;
const FONT_HOST_RE = /fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net|fonts\.cdnfonts\.com/i;
const CHART_PATH_RE = /(?:^|\/)[^/]*(?:chart|graph|plot|viz|visuali[sz]ation|sparkline)[^/]*\.(?:tsx|jsx|ts|js)$/i;
const CHART_IMPORT_RE = /from\s+["'](?:recharts|chart\.js(?:\/auto)?|react-chartjs-2|d3(?:-[a-z]+)?|victory|@nivo\/[a-z-]+|@visx\/[a-z-]+|echarts(?:-for-react)?|apexcharts|react-apexcharts)["']/;
const IMAGE_LITERAL_RE = /^(?:\/images\/\S+|https?:\/\/\S+\.(?:png|jpe?g|webp|avif|gif)(?:\?\S*)?|\S+\.(?:png|jpe?g|webp|avif|gif))$/i;
const BINARY_EXT_RE = /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|heic|woff2?|ttf|otf|eot|pdf|mp4|webm|mov|mp3|wav|ogg|zip)$/i;
const STYLE_COLOR_PROPS = new Set([
  "color", "background", "backgroundColor", "backgroundImage", "borderColor", "border", "borderTop", "borderBottom", "borderLeft",
  "borderRight", "borderTopColor", "borderBottomColor", "borderLeftColor", "borderRightColor", "outline", "outlineColor", "fill",
  "stroke", "boxShadow", "textShadow", "caretColor", "accentColor", "textDecorationColor", "stopColor",
]);
const CLASS_CALLS = new Set(["cn", "clsx", "cx", "cva", "twMerge", "classNames", "classnames"]);
const WRAPPER_TAGS = new Set(["div", "main", "Fragment", "React.Fragment", "article", "Layout", "Container"]);
const REMOVE_WORDS = /\b(?:remove|removes|removing|delete|deletes|drop|get rid of|replace|replacing|swap out|take out|hide)\b/i;
const MOVE_WORDS = /\b(?:move|moves|moving|reorder|rearrange|swap|above|below|before|after|first|last|to the top|to the bottom)\b/i;
const NAV_WORDS = /\b(?:nav|navigation|navbar|menu|header|footer|link|links|tab|tabs)\b/i;
const IMAGE_WORDS = /\b(?:image|images|photo|photos|picture|pictures|logo|banner|background|gallery|hero shot)\b/i;
const FONT_WORDS = /\b(?:font|fonts|typeface|typefaces|typography|serif|sans|lettering|handwriting|script font)\b/i;
const LAYOUT_WORDS = /\b(?:layout|variant|style of the|look of the|split|centered|centred|two columns?|full[- ]width)\b/i;
const REDESIGN_RE =
  /\b(?:redesign|re-design|redo the (?:design|look|layout|site)|new (?:look|layout|design|style)|different (?:look|layout|design|style)|change the (?:whole |entire |site'?s? |website'?s? )(?:layout|design)|start over|from scratch|revamp|overhaul|makeover|fresh look|rebuild the (?:site|website|page|home ?page))\b/i;

const EVIDENCE_MAX = 200;

export function sanitizeEvidence(text: string): string {
  return text
    .replace(/\b(mailto|tel|sms):[^\s"'`<>]*/gi, (_m, scheme: string) => `${scheme.toLowerCase()}:`)
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s"'`<>?#]*|(?<![\w:])\/[^\s"'`<>?#]*|[\w.-]+\.(?:png|jpe?g|webp|avif|gif|svg|css|js))[?#][^\s"'`<>]*/gi, "$1")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .slice(0, EVIDENCE_MAX);
}

function linkValue(raw: string): string {
  const v = raw.trim();
  return /^(?:mailto|tel|sms):/i.test(v) ? `${v.slice(0, v.indexOf(":")).toLowerCase()}:` : v.replace(/[?#].*$/, "");
}

export function isRedesignRequest(text: string | null | undefined): boolean {
  return typeof text === "string" && REDESIGN_RE.test(text.slice(0, 4000));
}

type Candidate = { kind: FindingKind; line: number; evidence: string; key: string; exception?: string };
type SectionEntry = { id: string; tag: string; variant: string | null; line: number; margins: string[] };
type Facts = {
  candidates: Candidate[];
  spacing: Array<{ line: number; value: string }>;
  sections: SectionEntry[] | null;
  rootRhythm: string[];
  routes: string[];
  hrefs: string[];
  images: string[];
};

function emptyFacts(): Facts {
  return { candidates: [], spacing: [], sections: null, rootRhythm: [], routes: [], hrefs: [], images: [] };
}

function extOf(path: string): "script" | "css" | "html" | null {
  if (/\.(?:tsx|jsx|ts|js|mjs)$/.test(path)) return "script";
  if (/\.css$/.test(path)) return "css";
  if (/\.html?$/.test(path)) return "html";
  return null;
}

function isPlatformPath(path: string): boolean {
  return path === "src/theme.css" || path.startsWith("src/zavi/") || path === "vite-zavi-head.ts" || path.startsWith("scripts/") || /(?:^|\/)__tests__\//.test(path);
}

function isPageFile(path: string): boolean {
  return /^src\/pages\/.+\.(?:tsx|jsx)$/.test(path) || /^src\/App\.(?:tsx|jsx)$/.test(path);
}

function isNavFile(path: string): boolean {
  return path === "src/site.ts" || /^src\/App\.(?:tsx|jsx)$/.test(path) || /(?:^|\/)(?:SiteHeader|Header|Nav|NavBar|Navbar|Navigation|TopBar)\.(?:tsx|jsx)$/.test(path);
}

function isChart(path: string, source: string): boolean {
  return CHART_PATH_RE.test(path) || CHART_IMPORT_RE.test(source);
}

function lineAt(source: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source.charCodeAt(i) === 10) n++;
  return n;
}

function colorWords(evidence: string): string[] {
  const out: string[] = [];
  const hue = new RegExp(`(?:^|[^a-z])(${TW_HUES}|black|white)(?:[^a-z]|$)`, "i").exec(evidence)?.[1];
  if (hue) out.push(hue.toLowerCase() === "grey" ? "gray" : hue.toLowerCase());
  const hex = /#[0-9a-fA-F]{3,8}/.exec(evidence)?.[0];
  if (hex) out.push(hex.toLowerCase());
  const named = STYLE_NAMED_COLOR_RE.exec(evidence)?.[0];
  if (named) out.push(named.toLowerCase() === "grey" ? "gray" : named.toLowerCase());
  return out;
}

function founderNamesColor(request: string, evidence: string): string | null {
  const req = request.toLowerCase().replace(/\bgrey\b/g, "gray");
  for (const w of colorWords(evidence)) {
    if (w.startsWith("#") ? req.includes(w) : new RegExp(`\\b${w}\\b`).test(req)) return w;
  }
  return null;
}

function classToken(token: string, line: number, siblings: string[], facts: Facts): void {
  const m = RAW_COLOR_CLASS_RE.exec(token);
  if (m) {
    const prefix = m[1];
    const hue = m[2] ? `${m[2]}-${m[3]}` : m[4] ?? "";
    const opacity = !!m[6];
    const overlay = siblings.some((s) => OVERLAY_CLASS_RE.test(s));
    const scrim =
      overlay &&
      (hue === "black" || hue === "white" || (SCRIM_HUE_RE.test(hue) && (opacity || /^(?:from|via|to)$/.test(prefix))));
    facts.candidates.push({
      kind: "raw_color",
      line,
      evidence: token,
      key: `raw_color|${token}`,
      ...(scrim ? { exception: "image overlay or scrim colour" } : {}),
    });
  }
  if (ARBITRARY_SPACING_RE.test(token)) facts.spacing.push({ line, value: token });
  if (FONT_CLASS_RE.test(token)) facts.candidates.push({ kind: "font_change", line, evidence: token, key: `font_change|${token}` });
}

function scanClassString(text: string, line: number, facts: Facts): void {
  const tokens = text.split(/\s+/).filter(Boolean);
  for (const t of tokens) classToken(t, line, tokens, facts);
}

function stringText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
  return null;
}

function attrName(node: ts.Node): string | null {
  if (ts.isJsxAttribute(node)) return node.name.getText();
  if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) return node.name.text;
  return null;
}

function attrValue(el: ts.JsxOpeningLikeElement, name: string): string | null {
  for (const p of el.attributes.properties) {
    if (!ts.isJsxAttribute(p) || p.name.getText() !== name || !p.initializer) continue;
    if (ts.isStringLiteral(p.initializer)) return p.initializer.text;
    const e = ts.isJsxExpression(p.initializer) ? p.initializer.expression : undefined;
    if (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))) return e.text;
  }
  return null;
}

function classesOf(el: ts.JsxOpeningLikeElement): string[] {
  const v = attrValue(el, "className") ?? attrValue(el, "class");
  return v ? v.split(/\s+/).filter(Boolean) : [];
}

function openingOf(node: ts.Node): ts.JsxOpeningLikeElement | null {
  if (ts.isJsxSelfClosingElement(node)) return node;
  if (ts.isJsxElement(node)) return node.openingElement;
  return null;
}

function elementChildren(node: ts.Node): ts.Node[] {
  const kids = ts.isJsxElement(node) || ts.isJsxFragment(node) ? node.children : [];
  return kids.filter((k) => ts.isJsxElement(k) || ts.isJsxSelfClosingElement(k));
}

function firstMarker(node: ts.Node): string | null {
  let found: string | null = null;
  const walk = (n: ts.Node): void => {
    if (found) return;
    const op = openingOf(n);
    if (op) {
      const v = attrValue(op, "data-zavi-section");
      if (v) {
        found = v;
        return;
      }
    }
    n.forEachChild(walk);
  };
  walk(node);
  return found;
}

function pageSections(sf: ts.SourceFile): { sections: SectionEntry[]; rootRhythm: string[] } | null {
  const outer: ts.Node[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      outer.push(n);
      return;
    }
    n.forEachChild(walk);
  };
  walk(sf);
  if (outer.length === 0) return null;
  let root = outer.reduce((a, b) => (b.getEnd() - b.getStart(sf) > a.getEnd() - a.getStart(sf) ? b : a));
  for (let depth = 0; depth < 4; depth++) {
    const kids = elementChildren(root);
    const op = openingOf(root);
    const tag = op ? op.tagName.getText(sf) : "Fragment";
    if (kids.length === 1 && WRAPPER_TAGS.has(tag)) root = kids[0];
    else break;
  }
  const rootOp = openingOf(root);
  const rootRhythm = rootOp ? classesOf(rootOp).filter((c) => ROOT_RHYTHM_RE.test(c)) : [];
  const sections = elementChildren(root).map((k) => {
    const op = openingOf(k) as ts.JsxOpeningLikeElement;
    const tag = op.tagName.getText(sf);
    const marker = firstMarker(k);
    const id = marker ?? `${tag}${attrValue(op, "id") ? `#${attrValue(op, "id")}` : ""}`;
    return {
      id,
      tag,
      variant: attrValue(op, "variant"),
      line: sf.getLineAndCharacterOfPosition(k.getStart(sf)).line + 1,
      margins: classesOf(op).filter((c) => SECTION_MARGIN_RE.test(c) && !ARBITRARY_SPACING_RE.test(c)),
    };
  });
  return { sections, rootRhythm };
}

function scanScript(path: string, source: string): Facts {
  const facts = emptyFacts();
  const kind = path.endsWith(".jsx") || path.endsWith(".js") ? ts.ScriptKind.JSX : path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.TSX;
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const styled = new Set<ts.Node>();
  const nav = isNavFile(path);
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === "style" && node.initializer && ts.isJsxExpression(node.initializer)) {
      const obj = node.initializer.expression;
      if (obj && ts.isObjectLiteralExpression(obj)) {
        for (const p of obj.properties) {
          if (!ts.isPropertyAssignment(p)) continue;
          const name = p.name.getText(sf).replace(/^["']|["']$/g, "");
          const text = stringText(p.initializer);
          if (text === null) continue;
          styled.add(p.initializer);
          if (name === "fontFamily" && !/^\s*(?:var\(|inherit|initial)/.test(text)) {
            facts.candidates.push({ kind: "font_change", line: line(p), evidence: `fontFamily: ${text}`, key: `font_change|fontFamily:${text}` });
          } else if (STYLE_COLOR_PROPS.has(name) && (COLOR_LITERAL_RE.test(text) || STYLE_NAMED_COLOR_RE.test(text.replace(/var\([^)]*\)/g, "")))) {
            facts.candidates.push({ kind: "raw_color", line: line(p), evidence: `style ${name}: ${text}`, key: `raw_color|style:${name}:${text}` });
          }
        }
      }
    }
    const text = stringText(node);
    if (text !== null && !styled.has(node)) {
      const owner = attrName(node.parent) ?? (ts.isJsxExpression(node.parent) ? attrName(node.parent.parent) : null);
      const isLink = owner !== null && /^(?:href|to|path|id|key)$/.test(owner);
      if (!isLink && HEX_LITERAL_RE.test(text.trim())) {
        facts.candidates.push({ kind: "raw_color", line: line(node), evidence: text.trim(), key: `raw_color|${text.trim()}` });
      } else if (/\s|-/.test(text) || /^[a-z]/.test(text)) {
        scanClassString(text, line(node), facts);
      }
      if (FONT_HOST_RE.test(text)) facts.candidates.push({ kind: "font_change", line: line(node), evidence: text.slice(0, 120), key: `font_change|${text}` });
      if (IMAGE_LITERAL_RE.test(text.trim())) facts.images.push(linkValue(text));
      if (owner !== null && /^(?:href|to)$/.test(owner) && nav) facts.hrefs.push(/^\s*(?:mailto|tel|sms):/i.test(text) ? linkValue(text) : text);
      if (owner === "path" && /^src\/App\./.test(path)) facts.routes.push(text);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  facts.routes = [...new Set(facts.routes)];
  if (isPageFile(path)) {
    const page = pageSections(sf);
    if (page) {
      facts.sections = page.sections;
      facts.rootRhythm = page.rootRhythm;
    }
  }
  return facts;
}

function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

const ROOT_SELECTOR_RE = /^(?::root|html|\.dark|:root\.dark|html\.dark|:root\[data-theme[^\]]*\]|\[data-theme[^\]]*\])(?:\s*,\s*(?::root|html|\.dark|:root\.dark|html\.dark))*$/;

function scanCss(path: string, source: string, lineOffset: number, facts: Facts): void {
  const css = blankComments(source);
  const stack: string[] = [];
  let buf = "";
  let bufStart = 0;
  let parens = 0;
  let quote: string | null = null;
  const indexCss = path === "src/index.css";
  const decl = (raw: string, at: number): void => {
    const text = raw.trim();
    if (!text) return;
    const line = lineOffset + lineAt(css, at + raw.search(/\S/)) - 1;
    if (stack.length === 0 && text.startsWith("@import")) {
      if (FONT_HOST_RE.test(text) || /font/i.test(text)) facts.candidates.push({ kind: "font_change", line, evidence: text.slice(0, 160), key: `font_change|${text}` });
      return;
    }
    if (stack.length === 0) return;
    if (text.startsWith("@apply")) {
      scanClassString(text.slice(6), line, facts);
      return;
    }
    const colon = text.indexOf(":");
    if (colon <= 0) return;
    const prop = text.slice(0, colon).trim().toLowerCase();
    const value = text.slice(colon + 1).trim().replace(/\s*!important$/, "");
    const inner = stack[stack.length - 1];
    const tokenBlock = indexCss && prop.startsWith("--") && ROOT_SELECTOR_RE.test(inner);
    if (prop === "font-family" || /^--font-/.test(prop) || (prop === "font" && /["']/.test(value))) {
      if (!/^(?:var\([^)]*\)|inherit|initial|unset)$/.test(value)) {
        facts.candidates.push({ kind: "font_change", line, evidence: `${prop}: ${value}`.slice(0, 160), key: `font_change|${prop}:${value}` });
      }
      return;
    }
    const noUrl = value.replace(/url\((?:[^()]|\([^()]*\))*\)/gi, "");
    const rgbTriple = prop.startsWith("--") && /^\d{1,3}\s+\d{1,3}\s+\d{1,3}(?:\s*\/\s*[\d.]+%?)?$/.test(value);
    if (COLOR_LITERAL_RE.test(noUrl) || rgbTriple) {
      facts.candidates.push({
        kind: "raw_color",
        line,
        evidence: `${prop}: ${value}`.slice(0, 160),
        key: `raw_color|${prop}:${value}`,
        ...(tokenBlock ? { exception: "theme token override in the :root block of src/index.css" } : {}),
      });
    }
  };
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      buf += ch;
      if (ch === "\\") {
        buf += css[i + 1] ?? "";
        i++;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (!buf.trim()) bufStart = i;
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "(") parens++;
    if (ch === ")") parens = Math.max(0, parens - 1);
    if (parens === 0 && ch === "{") {
      const sel = buf.trim().replace(/\s+/g, " ");
      if (/^@font-face\b/.test(sel)) {
        const line = lineOffset + lineAt(css, bufStart + buf.search(/\S/)) - 1;
        facts.candidates.push({ kind: "font_change", line, evidence: "@font-face", key: `font_change|@font-face|${line}` });
      }
      stack.push(sel);
      buf = "";
      bufStart = i + 1;
      continue;
    }
    if (parens === 0 && (ch === "}" || ch === ";")) {
      decl(buf, bufStart);
      if (ch === "}") stack.pop();
      buf = "";
      bufStart = i + 1;
      continue;
    }
    if (!buf.trim() && /\s/.test(ch)) {
      bufStart = i + 1;
      buf += ch;
      continue;
    }
    buf += ch;
  }
}

function scanHtml(path: string, source: string): Facts {
  const facts = emptyFacts();
  for (const m of source.matchAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    if (FONT_HOST_RE.test(m[1])) facts.candidates.push({ kind: "font_change", line: lineAt(source, m.index ?? 0), evidence: m[1].slice(0, 160), key: `font_change|${m[1]}` });
  }
  for (const m of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const start = (m.index ?? 0) + m[0].indexOf(">") + 1;
    scanCss(path, m[1], lineAt(source, start), facts);
  }
  for (const m of source.matchAll(/\bstyle=["']([^"']*)["']/gi)) {
    if (COLOR_LITERAL_RE.test(m[1])) facts.candidates.push({ kind: "raw_color", line: lineAt(source, m.index ?? 0), evidence: `style="${m[1].slice(0, 120)}"`, key: `raw_color|style:${m[1]}` });
    if (/font-family\s*:/i.test(m[1])) facts.candidates.push({ kind: "font_change", line: lineAt(source, m.index ?? 0), evidence: `style="${m[1].slice(0, 120)}"`, key: `font_change|style:${m[1]}` });
  }
  for (const m of source.matchAll(/\bclass=["']([^"']*)["']/gi)) scanClassString(m[1], lineAt(source, m.index ?? 0), facts);
  for (const m of source.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)) facts.images.push(linkValue(m[1]));
  return facts;
}

function factsOf(path: string, source: string): Facts {
  const ext = extOf(path);
  if (ext === "script") return scanScript(path, source);
  if (ext === "html") return scanHtml(path, source);
  const facts = emptyFacts();
  scanCss(path, source, 1, facts);
  return facts;
}

function multisetMinus<T>(after: T[], before: T[], key: (t: T) => string): T[] {
  const left = new Map<string, number>();
  for (const b of before) left.set(key(b), (left.get(key(b)) ?? 0) + 1);
  return after.filter((a) => {
    const n = left.get(key(a)) ?? 0;
    if (n > 0) {
      left.set(key(a), n - 1);
      return false;
    }
    return true;
  });
}

function pageName(path: string): string[] {
  if (/^src\/App\./.test(path)) return ["home", "homepage", "home page", "landing", "front page", "main page"];
  const base = (path.split("/").pop() ?? "").replace(/\.(?:tsx|jsx)$/, "");
  const words = base.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").toLowerCase().replace(/\s*page$/, "").trim();
  const names = [words, words.replace(/\s+/g, "")];
  if (words === "home" || words === "index") names.push("home", "homepage", "home page", "landing", "front page", "main page");
  return [...new Set(names.filter(Boolean))];
}

function namedIn(request: string, names: string[]): boolean {
  const req = request.toLowerCase();
  return names.some((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`).test(req));
}

function targetPages(files: AdherenceFile[], scope: AdherenceScope, request: string): Set<string> {
  const pages = files.filter((f) => isPageFile(f.path) && !/^src\/App\./.test(f.path));
  const out = new Set<string>();
  for (const f of pages) {
    if (f.action !== "modify") out.add(f.path);
    else if (namedIn(request, pageName(f.path))) out.add(f.path);
  }
  const namedAny = pages.some((f) => f.action === "modify" && namedIn(request, pageName(f.path)));
  if (!namedAny && (scope === "section" || scope === "data")) {
    const home = files.find((f) => /^src\/pages\/(?:Home|Index|HomePage)\.(?:tsx|jsx)$/i.test(f.path));
    if (home) out.add(home.path);
    else if (!files.some((f) => /^src\/pages\//.test(f.path))) {
      const app = files.find((f) => /^src\/App\.(?:tsx|jsx)$/.test(f.path));
      if (app) out.add(app.path);
    }
  }
  return out;
}

function sameOrder(a: string[], b: string[]): boolean {
  const common = multisetMinus(a, multisetMinus(a, b, (x) => x), (x) => x);
  const commonB = multisetMinus(b, multisetMinus(b, a, (x) => x), (x) => x);
  return common.join("\u0000") === commonB.join("\u0000");
}

function structureFindings(
  file: AdherenceFile,
  before: Facts,
  after: Facts,
  intent: AdherenceIntent,
  targets: Set<string>,
): DesignFinding[] {
  const out: DesignFinding[] = [];
  const request = intent.founderStyleRequest ?? "";
  const scope = intent.scope;
  const narrow = scope === "tweak" || scope === "theme";
  const isTarget = targets.has(file.path);
  const push = (line: number | undefined, evidence: string) =>
    out.push({ kind: "structure_drift", file: file.path, ...(line ? { line } : {}), evidence: evidence.slice(0, 200), severity: "warn" });

  if (isPageFile(file.path) && !/^src\/App\./.test(file.path) && file.action !== "modify") {
    if (narrow) push(undefined, `${file.action === "create" ? "added" : "removed"} page ${file.path} in a ${scope} change`);
    else if (scope === "section") push(undefined, `${file.action === "create" ? "added" : "removed"} page ${file.path} in a section change`);
    return out;
  }

  if (before.sections && after.sections && file.action === "modify") {
    const b = before.sections.map((s) => s.id);
    const a = after.sections.map((s) => s.id);
    const added = multisetMinus(a, b, (x) => x);
    const removed = multisetMinus(b, a, (x) => x);
    const reordered = !sameOrder(b, a);
    const firstLine = after.sections[0]?.line;
    const variantChanges: string[] = [];
    const seen = new Map<string, number>();
    for (const s of before.sections) {
      const nth = seen.get(s.id) ?? 0;
      seen.set(s.id, nth + 1);
      const match = after.sections.filter((x) => x.id === s.id)[nth];
      if (match && match.variant !== s.variant) variantChanges.push(`${s.id} variant ${s.variant ?? "default"} -> ${match.variant ?? "default"}`);
    }
    const allowAll = scope === "page" ? isTarget : false;
    if (!allowAll) {
      const local = !narrow && isTarget;
      if (added.length && !local) push(firstLine, `sections added: ${added.join(", ")}`);
      if (removed.length && !(local && REMOVE_WORDS.test(request))) push(firstLine, `sections removed: ${removed.join(", ")}`);
      if (reordered && !(local && MOVE_WORDS.test(request))) push(firstLine, `sections reordered: ${b.join(" > ")} became ${a.join(" > ")}`);
      if (variantChanges.length && !(local && LAYOUT_WORDS.test(request))) push(firstLine, `section layout changed: ${variantChanges.join("; ")}`);
    }
  }

  if (/^src\/App\./.test(file.path) && file.action === "modify") {
    const added = multisetMinus(after.routes, before.routes, (x) => x);
    const removed = multisetMinus(before.routes, after.routes, (x) => x);
    const routesOk = scope === "page" || (scope === "data" && removed.length === 0);
    if ((added.length || removed.length) && !routesOk) {
      push(undefined, `routes changed: ${[...added.map((r) => `+${r}`), ...removed.map((r) => `-${r}`)].join(" ")}`);
    }
  }

  if (isNavFile(file.path) && file.action === "modify") {
    const added = multisetMinus(after.hrefs, before.hrefs, (x) => x);
    const removed = multisetMinus(before.hrefs, after.hrefs, (x) => x);
    const navOk = scope === "page" || (scope !== "theme" && NAV_WORDS.test(request));
    const flaggedAdds = scope === "section" || scope === "data" ? added.filter((h) => !h.includes("#")) : added;
    if ((flaggedAdds.length || removed.length) && !navOk) {
      push(undefined, `navigation links changed: ${[...flaggedAdds.map((r) => `+${r}`), ...removed.map((r) => `-${r}`)].join(" ")}`);
    }
  }

  if (file.action === "modify") {
    const added = multisetMinus(after.images, before.images, (x) => x);
    const removed = multisetMinus(before.images, after.images, (x) => x);
    if (added.length || removed.length) {
      const imageOk = narrow ? scope === "tweak" && IMAGE_WORDS.test(request) : !isPageFile(file.path) || isTarget;
      if (!imageOk) push(undefined, `images changed: ${[...added.map((r) => `+${r}`), ...removed.map((r) => `-${r}`)].join(" ")}`);
    }
  }
  return out;
}

function emptyCounts(): Record<FindingKind, number> {
  return { raw_color: 0, font_change: 0, spacing_drift: 0, structure_drift: 0 };
}

export function checkDesignAdherence(input: { files: AdherenceFile[]; intent: AdherenceIntent }): AdherenceReport {
  const { intent } = input;
  const request = (intent.founderStyleRequest ?? "").slice(0, 4000);
  const findings: DesignFinding[] = [];
  const skipped: string[] = [];
  let checked = 0;
  const usable: Array<{ file: AdherenceFile; before: Facts; after: Facts }> = [];
  for (const file of input.files.slice(0, MAX_ADHERENCE_FILES)) {
    if (!extOf(file.path) || isPlatformPath(file.path)) continue;
    if (BINARY_EXT_RE.test(file.path)) continue;
    const texts = [file.before, file.after];
    if (texts.some((t) => typeof t === "string" && (t.length > MAX_ADHERENCE_FILE_BYTES || t.includes("\u0000")))) {
      skipped.push(`${file.path}: too large or binary`);
      continue;
    }
    if (file.action !== "create" && file.before === null) {
      skipped.push(`${file.path}: previous version unavailable`);
      continue;
    }
    if (file.action !== "delete" && file.after === null) {
      skipped.push(`${file.path}: new version unavailable`);
      continue;
    }
    if (file.action === "modify" && file.before === file.after) continue;
    try {
      const before = file.action === "create" ? emptyFacts() : factsOf(file.path, file.before ?? "");
      const after = file.action === "delete" ? emptyFacts() : factsOf(file.path, file.after ?? "");
      usable.push({ file, before, after });
      checked++;
    } catch {
      skipped.push(`${file.path}: could not be read`);
    }
  }
  if (input.files.length > MAX_ADHERENCE_FILES) skipped.push(`${input.files.length - MAX_ADHERENCE_FILES} files over the ${MAX_ADHERENCE_FILES} file cap`);

  const spacingItems: Array<{ file: string; line: number; value: string }> = [];
  for (const { file, before, after } of usable) {
    const source = file.after ?? "";
    const chart = extOf(file.path) === "script" && isChart(file.path, source);
    for (const c of multisetMinus(after.candidates, before.candidates, (x) => x.key)) {
      let exception = c.exception;
      if (!exception && c.kind === "raw_color" && chart) exception = "chart or data visualisation colours";
      if (!exception && c.kind === "raw_color" && request) {
        const named = founderNamesColor(request, c.evidence);
        if (named) exception = `the founder asked for ${named}`;
      }
      if (!exception && c.kind === "font_change") {
        if (intent.redesign) exception = "the founder asked for a redesign";
        else if (FONT_WORDS.test(request)) exception = "the founder asked for a font change";
      }
      findings.push({
        kind: c.kind,
        file: file.path,
        line: c.line,
        evidence: c.evidence,
        severity: exception ? "info" : "warn",
        ...(exception ? { exception } : {}),
      });
    }
    for (const s of multisetMinus(after.spacing, before.spacing, (x) => x.value)) spacingItems.push({ file: file.path, ...s });
    if (after.sections) {
      const beforeMargins = (before.sections ?? []).flatMap((s) => s.margins.map((m) => `${s.id} ${m}`));
      const afterMargins = after.sections.flatMap((s) => s.margins.map((m) => ({ line: s.line, value: `${s.id} ${m}` })));
      for (const m of multisetMinus(afterMargins, beforeMargins.map((v) => ({ line: 0, value: v })), (x) => x.value)) {
        spacingItems.push({ file: file.path, line: m.line, value: m.value });
      }
      for (const r of multisetMinus(after.rootRhythm, before.rootRhythm, (x) => x)) spacingItems.push({ file: file.path, line: after.sections[0]?.line ?? 1, value: `page wrapper ${r}` });
    }
  }
  if (spacingItems.length >= SPACING_DRIFT_MIN) {
    const byFile = new Map<string, typeof spacingItems>();
    for (const s of spacingItems) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
    for (const [file, items] of byFile) {
      findings.push({
        kind: "spacing_drift",
        file,
        line: items[0].line,
        evidence: `${items.length} one-off spacing values: ${items.slice(0, 5).map((i) => i.value).join(", ")}`.slice(0, 200),
        severity: "warn",
      });
    }
  }

  if (intent.scope !== "first_build" && !intent.redesign) {
    const targets = targetPages(usable.map((u) => u.file), intent.scope, request);
    for (const u of usable) findings.push(...structureFindings(u.file, u.before, u.after, intent, targets));
  }

  for (const f of findings) f.evidence = sanitizeEvidence(f.evidence);
  const warn = emptyCounts();
  let info = 0;
  for (const f of findings) {
    if (f.severity === "warn") warn[f.kind]++;
    else info++;
  }
  return { findings, warn, info, checked, skipped };
}

export type AdherenceChangedFile = { path: string; action: "create" | "modify" | "delete"; content?: string; encoding?: string };

export type AdherenceReportInput = {
  tenant_id: string;
  run_id: string;
  first_build: boolean;
  payload: unknown;
  files: readonly AdherenceChangedFile[];
};

export type HeadReader = (paths: readonly string[]) => Promise<ReadonlyMap<string, string | null>>;

export type AdherenceReportDeps = {
  readBefore: HeadReader;
  settingOn?: (tenant_id: string) => Promise<boolean>;
  check?: typeof checkDesignAdherence;
  log?: (line: Record<string, unknown>) => void;
  now?: () => number;
  timeoutMs?: number;
};

export type AdherenceSummary = {
  scope: AdherenceScope;
  redesign: boolean;
  checked: number;
  warn: Record<FindingKind, number>;
  info: number;
  findings: DesignFinding[];
};

export const ADHERENCE_LOG_FINDINGS = 8;
export const ADHERENCE_READ_TIMEOUT_MS = 20_000;

export const ADHERENCE_READ_TOTAL_BYTES = 4_000_000;

function headReadScript(repoRoot: string, paths: readonly string[]): string {
  const list = Buffer.from(paths.join("\n"), "utf8").toString("base64");
  return [
    `printf '%s' '${list}' | base64 -d | {`,
    "i=0; total=0;",
    "while IFS= read -r p || [ -n \"$p\" ]; do",
    `t=$(git -C '${repoRoot}' cat-file -t "HEAD:$p" 2>/dev/null);`,
    `s=$(git -C '${repoRoot}' cat-file -s "HEAD:$p" 2>/dev/null);`,
    'if [ "$t" != blob ] || [ -z "$s" ]; then printf \'%s -\\n\' "$i";',
    `elif [ "$s" -gt ${MAX_ADHERENCE_FILE_BYTES} ] || [ $((total + s)) -gt ${ADHERENCE_READ_TOTAL_BYTES} ]; then printf '%s L\\n' "$i";`,
    `else total=$((total + s)); printf '%s B' "$i"; git -C '${repoRoot}' cat-file blob "HEAD:$p" | base64 | tr -d '\\n'; printf '\\n';`,
    "fi; i=$((i + 1)); done; }",
  ].join(" ");
}

export function sandboxHeadReader(
  exec: (command: string) => Promise<{ exit_code: number; stdout: string }>,
  repoRoot: string,
): HeadReader {
  return async (paths) => {
    const out = new Map<string, string | null>();
    for (const p of paths) out.set(p, null);
    if (!/^\/home\/user\/[A-Za-z0-9._/-]+$/.test(repoRoot) || repoRoot.includes("..")) return out;
    const safe = [...new Set(paths)].filter(
      (p) => p.length > 0 && p.length <= 400 && !/[\u0000-\u001f\u007f]/.test(p) && !p.startsWith("/") && !p.split("/").includes(".."),
    );
    if (safe.length === 0) return out;
    const res = await exec(headReadScript(repoRoot, safe));
    if (res.exit_code !== 0) return out;
    for (const line of res.stdout.split("\n")) {
      const m = /^(\d+) ([-LB])([A-Za-z0-9+/=]*)$/.exec(line);
      const path = m ? safe[Number(m[1])] : undefined;
      if (!m || path === undefined || m[2] !== "B") continue;
      out.set(path, Buffer.from(m[3], "base64").toString("utf8"));
    }
    return out;
  };
}

async function defaultSettingOn(tenant_id: string): Promise<boolean> {
  return (await getBoolSetting("site_design_adherence_report", tenant_id)) === true;
}

function payloadText(payload: unknown, key: string): string {
  const v = (payload as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : "";
}

export async function reportSiteDesignAdherence(input: AdherenceReportInput, deps: AdherenceReportDeps): Promise<AdherenceSummary | null> {
  const log = deps.log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify(line)));
  const now = deps.now ?? Date.now;
  const site_id = payloadText(input.payload, "site_id") || null;
  try {
    if (!(await (deps.settingOn ?? defaultSettingOn)(input.tenant_id))) return null;
    const started = now();
    const editSize = (input.payload as { edit_size?: unknown } | null)?.edit_size;
    const scope: AdherenceScope = input.first_build ? "first_build" : isSiteEditSize(editSize) ? editSize : "section";
    const request = (payloadText(input.payload, "user_request") || payloadText(input.payload, "idea")).slice(0, 4000);
    const intent: AdherenceIntent = { scope, redesign: isRedesignRequest(request), ...(request ? { founderStyleRequest: request } : {}) };
    const base = { evt: "site_design_adherence", tenant_id: input.tenant_id, site_id, run_id: input.run_id, scope, redesign: intent.redesign };
    try {
      const relevant = input.files
        .filter((f) => extOf(f.path) && !isPlatformPath(f.path) && !BINARY_EXT_RE.test(f.path) && f.encoding !== "base64")
        .slice(0, MAX_ADHERENCE_FILES);
      const wanted = relevant.filter((f) => f.action !== "create").map((f) => f.path);
      const reads: Promise<AdherenceFile[]> = (async () => {
        let previous: ReadonlyMap<string, string | null> = new Map();
        if (wanted.length) {
          try {
            previous = await deps.readBefore(wanted);
          } catch {
            previous = new Map();
          }
        }
        return relevant.map((f) => ({
          path: f.path,
          action: f.action,
          before: f.action === "create" ? null : (previous.get(f.path) ?? null),
          after: f.action === "delete" ? null : typeof f.content === "string" ? f.content : null,
        }));
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const files = await Promise.race([
        reads,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("reading the previous versions timed out")), deps.timeoutMs ?? ADHERENCE_READ_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      const report = (deps.check ?? checkDesignAdherence)({ files, intent });
      const summary: AdherenceSummary = {
        scope,
        redesign: intent.redesign,
        checked: report.checked,
        warn: report.warn,
        info: report.info,
        findings: report.findings.slice(0, ADHERENCE_LOG_FINDINGS).map((f) => ({ ...f, evidence: sanitizeEvidence(f.evidence) })),
      };
      log({
        ...base,
        outcome: "checked",
        files_checked: report.checked,
        skipped: report.skipped.slice(0, 5),
        warn: report.warn,
        info: report.info,
        total: report.findings.length,
        findings: summary.findings.map((f) => ({ ...f, evidence: f.evidence.slice(0, 160) })),
        ms: now() - started,
      });
      return summary;
    } catch (e) {
      log({ ...base, outcome: "error", error: String((e as Error)?.message ?? e).slice(0, 200), ms: now() - started });
      return null;
    }
  } catch {
    return null;
  }
}
