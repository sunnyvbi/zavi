
import ts from "typescript";
import { SITE_REPO_DIR, type SiteSandbox } from "./contract";
import { PLAN_SECTION_VARIANTS, PLAN_TONES, type PlanComponent } from "./design-brief";
import { sandboxScriptCommand } from "./site-text-direct";

export type SectionFile = { path: string; content: string };

export type SectionInfo = {
  id: string;
  component: PlanComponent;
  variant: string | null;
  tone: string | null;
  variants: readonly string[];
  tones: readonly string[];
  can_move_up: boolean;
  can_move_down: boolean;
};

export type SectionOp =
  | { kind: "variant"; section_id: string; variant: string }
  | { kind: "tone"; section_id: string; tone: string }
  | { kind: "move"; section_id: string; direction: "up" | "down" };

export type SectionEditError =
  | "not_found"
  | "many_matches"
  | "not_a_section"
  | "dynamic"
  | "bad_variant"
  | "bad_tone"
  | "not_movable"
  | "unreadable_source"
  | "no_change";

export const SECTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SECTION_PATH_RE = /^src\/(?:[A-Za-z0-9_@][A-Za-z0-9_.@-]*\/)*[A-Za-z0-9_@][A-Za-z0-9_.@-]*\.(?:tsx|jsx)$/;
const SECTION_IMPORT_RE = /(?:^|\/)sections(?:\/[A-Za-z]+)?$/;
const MARKER = "data-zavi-section";

type Found = {
  path: string;
  source: string;
  sf: ts.SourceFile;
  node: ts.JsxSelfClosingElement | ts.JsxElement;
  opening: ts.JsxSelfClosingElement | ts.JsxOpeningElement;
  component: string;
};

function parse(path: string, content: string): ts.SourceFile | null {
  const kind = path.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.TSX;
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind);
  return ((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length > 0 ? null : sf;
}

function attr(opening: ts.JsxSelfClosingElement | ts.JsxOpeningElement, name: string): ts.JsxAttribute | null {
  for (const p of opening.attributes.properties) {
    if (ts.isJsxAttribute(p) && p.name.getText() === name) return p;
  }
  return null;
}

function literal(a: ts.JsxAttribute | null): string | null | undefined {
  if (!a) return null;
  const init = a.initializer;
  if (init && ts.isStringLiteral(init)) return init.text;
  if (init && ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression)) return init.expression.text;
  return undefined;
}

function sectionImports(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!SECTION_IMPORT_RE.test(st.moduleSpecifier.text)) continue;
    const named = st.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) out.set(el.name.text, (el.propertyName ?? el.name).text);
    }
  }
  return out;
}

function markersIn(path: string, content: string): { found: Found[]; broken: boolean } {
  if (!content.includes(MARKER)) return { found: [], broken: false };
  const sf = parse(path, content);
  if (!sf) return { found: [], broken: true };
  const imports = sectionImports(sf);
  const found: Found[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxElement(n)) {
      const opening = ts.isJsxElement(n) ? n.openingElement : n;
      if (attr(opening, MARKER)) {
        const local = opening.tagName.getText(sf);
        found.push({ path, source: content, sf, node: n, opening, component: imports.get(local) ?? "" });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { found, broken: false };
}

function locate(files: ReadonlyArray<SectionFile>, id: string, pageFile: string | null = null): { found: Found } | { error: SectionEditError } {
  const hits: Found[] = [];
  let broken = false;
  for (const f of files) {
    if (!SECTION_PATH_RE.test(f.path)) continue;
    const r = markersIn(f.path, f.content);
    broken ||= r.broken && f.content.includes(`"${id}"`);
    for (const h of r.found) if (literal(attr(h.opening, MARKER)) === id) hits.push(h);
  }
  const onPage = pageFile ? hits.filter((h) => h.path === pageFile) : [];
  const pick = onPage.length === 1 ? onPage : hits;
  if (pick.length === 0) return { error: broken ? "unreadable_source" : "not_found" };
  if (pick.length > 1) return { error: "many_matches" };
  const found = pick[0]!;
  if (!Object.prototype.hasOwnProperty.call(PLAN_SECTION_VARIANTS, found.component)) return { error: "not_a_section" };
  return { found };
}

export function pageFileForPath(app: SectionFile | null, path: string, known: ReadonlyArray<string>): string | null {
  if (!app) return null;
  const sf = parse(app.path, app.content);
  if (!sf) return null;
  const imports = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.moduleSpecifier.text.startsWith(".")) continue;
    const name = st.importClause?.name?.text;
    if (name) imports.set(name, st.moduleSpecifier.text);
    const named = st.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) for (const el of named.elements) imports.set(el.name.text, st.moduleSpecifier.text);
  }
  const want = path.split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";
  let page: string | null = null;
  const visit = (n: ts.Node): void => {
    if (page) return;
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxElement(n)) {
      const opening = ts.isJsxElement(n) ? n.openingElement : n;
      if (opening.tagName.getText(sf) === "Route" && literal(attr(opening, "path")) === want) {
        const el = attr(opening, "element")?.initializer;
        const tags: string[] = [];
        const collect = (x: ts.Node): void => {
          if (ts.isJsxSelfClosingElement(x) || ts.isJsxOpeningElement(x)) tags.push(x.tagName.getText(sf));
          ts.forEachChild(x, collect);
        };
        if (el) collect(el);
        for (const t of tags) {
          const spec = imports.get(t);
          if (!spec) continue;
          const base = `src/${spec.replace(/^\.\//, "")}`;
          const file = known.find((k) => k === base || k.replace(/\.(tsx|jsx|ts)$/, "") === base);
          if (file) {
            page = file;
            return;
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return page;
}

function siblings(found: Found): Array<ts.JsxSelfClosingElement | ts.JsxElement> | null {
  const parent = found.node.parent;
  if (!parent || !(ts.isJsxElement(parent) || ts.isJsxFragment(parent))) return null;
  const out: Array<ts.JsxSelfClosingElement | ts.JsxElement> = [];
  for (const c of parent.children) {
    if (ts.isJsxText(c)) {
      if (!c.containsOnlyTriviaWhiteSpaces) return null;
      continue;
    }
    if (ts.isJsxExpression(c) && !c.expression) continue;
    if (ts.isJsxSelfClosingElement(c) || ts.isJsxElement(c)) {
      out.push(c);
      continue;
    }
    return null;
  }
  return out;
}

function isMarked(n: ts.JsxSelfClosingElement | ts.JsxElement): boolean {
  const opening = ts.isJsxElement(n) ? n.openingElement : n;
  return typeof literal(attr(opening, MARKER)) === "string";
}

function moveTarget(found: Found, direction: "up" | "down"): ts.JsxSelfClosingElement | ts.JsxElement | null {
  const sibs = siblings(found);
  if (!sibs) return null;
  const at = sibs.indexOf(found.node);
  const other = sibs[direction === "up" ? at - 1 : at + 1];
  return other && isMarked(other) ? other : null;
}

function infoOf(found: Found, id: string): SectionInfo {
  const component = found.component as PlanComponent;
  const v = literal(attr(found.opening, "variant"));
  const t = literal(attr(found.opening, "tone"));
  return {
    id,
    component,
    variant: typeof v === "string" ? v : null,
    tone: typeof t === "string" ? t : null,
    variants: PLAN_SECTION_VARIANTS[component],
    tones: component === "Hero" ? [] : PLAN_TONES,
    can_move_up: moveTarget(found, "up") !== null,
    can_move_down: moveTarget(found, "down") !== null,
  };
}

export function describeSection(files: ReadonlyArray<SectionFile>, id: string, pageFile: string | null = null): SectionInfo | { error: SectionEditError } {
  if (!SECTION_ID_RE.test(id)) return { error: "not_found" };
  const r = locate(files, id, pageFile);
  return "error" in r ? r : infoOf(r.found, id);
}

function setAttr(found: Found, name: string, value: string): { content: string } | { error: SectionEditError } {
  const a = attr(found.opening, name);
  const current = literal(a);
  if (current === undefined) return { error: "dynamic" };
  if (current === value) return { error: "no_change" };
  const src = found.source;
  if (a) {
    const init = a.initializer!;
    return { content: `${src.slice(0, init.getStart(found.sf))}"${value}"${src.slice(init.end)}` };
  }
  const at = found.opening.tagName.end;
  return { content: `${src.slice(0, at)} ${name}="${value}"${src.slice(at)}` };
}

export function applySectionOp(
  files: ReadonlyArray<SectionFile>,
  op: SectionOp,
  pageFile: string | null = null,
): { path: string; before: string; after: string; info: SectionInfo } | { error: SectionEditError } {
  if (!SECTION_ID_RE.test(op.section_id)) return { error: "not_found" };
  const r = locate(files, op.section_id, pageFile);
  if ("error" in r) return r;
  const found = r.found;
  const component = found.component as PlanComponent;
  let after: string;
  if (op.kind === "variant") {
    if (!(PLAN_SECTION_VARIANTS[component] as readonly string[]).includes(op.variant)) return { error: "bad_variant" };
    const s = setAttr(found, "variant", op.variant);
    if ("error" in s) return s;
    after = s.content;
  } else if (op.kind === "tone") {
    if (component === "Hero" || !(PLAN_TONES as readonly string[]).includes(op.tone)) return { error: "bad_tone" };
    const s = setAttr(found, "tone", op.tone);
    if ("error" in s) return s;
    after = s.content;
  } else {
    const other = moveTarget(found, op.direction);
    if (!other) return { error: "not_movable" };
    const [first, second] = op.direction === "up" ? [other, found.node] : [found.node, other];
    const src = found.source;
    const a0 = first.getStart(found.sf);
    const b0 = second.getStart(found.sf);
    const firstText = src.slice(a0, first.end);
    const secondText = src.slice(b0, second.end);
    after = `${src.slice(0, a0)}${secondText}${src.slice(first.end, b0)}${firstText}${src.slice(second.end)}`;
  }
  const check = locate([{ path: found.path, content: after }], op.section_id);
  if ("error" in check || !parse(found.path, after)) return { error: "unreadable_source" };
  return { path: found.path, before: found.source, after, info: infoOf(check.found, op.section_id) };
}

export function sectionEditMessage(error: SectionEditError): string {
  switch (error) {
    case "not_found":
    case "many_matches":
    case "not_a_section":
    case "dynamic":
    case "unreadable_source":
      return "This part of the page can't be rearranged here. Ask for the change in the chat.";
    case "bad_variant":
      return "That layout isn't available for this section.";
    case "bad_tone":
      return "That background isn't available for this section.";
    case "not_movable":
      return "This section can't move that way.";
    case "no_change":
      return "Nothing changed.";
  }
}

export function sectionOpLabel(op: SectionOp, info: Pick<SectionInfo, "component">): string {
  const name = info.component === "HoursLocation" ? "hours section" : `${info.component.toLowerCase()} section`;
  if (op.kind === "variant") return `Changed the ${name} layout`;
  if (op.kind === "tone") return `Changed the ${name} background`;
  return `Moved the ${name} ${op.direction}`;
}

const SECTION_READ_MARK = "__ZAVI_SECTIONS__";
const SECTION_READ_SCRIPT = String.raw`const fs = require("fs");
const files = [];
let total = 0;
let over = false;
function consider(rel, always) {
  let st; try { st = fs.lstatSync(rel); } catch (e) { return; }
  if (!st.isFile() || st.size > 400000) return;
  const c = fs.readFileSync(rel, "utf8");
  if (!always && !c.includes("data-zavi-section")) return;
  total += c.length;
  if (total > 2000000) { over = true; return; }
  files.push({ path: rel, content: c });
}
function walk(dir, depth) {
  if (over || depth > 12) return;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of ents) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const rel = dir + "/" + e.name;
    if (e.isDirectory()) walk(rel, depth + 1);
    else if (/\.(tsx|jsx)$/.test(e.name) && rel !== "src/App.tsx" && !rel.startsWith("src/components/sections/")) consider(rel, false);
  }
}
consider("src/App.tsx", true);
walk("src", 0);
process.stdout.write("${SECTION_READ_MARK}" + Buffer.from(JSON.stringify({ over, files })).toString("base64") + "\n");
`;

export async function readSectionFiles(sandbox: SiteSandbox): Promise<{ files: SectionFile[]; app: SectionFile | null } | null> {
  const r = await sandbox.run(sandboxScriptCommand(SECTION_READ_SCRIPT, {}), { cwd: SITE_REPO_DIR, timeoutMs: 30_000 });
  const line = r.stdout.split("\n").find((l) => l.startsWith(SECTION_READ_MARK));
  if (r.exitCode !== 0 || !line) return null;
  try {
    const v = JSON.parse(Buffer.from(line.slice(SECTION_READ_MARK.length), "base64").toString("utf8")) as { over?: unknown; files?: unknown };
    if (v.over === true || !Array.isArray(v.files)) return null;
    const files = (v.files as unknown[]).filter(
      (f): f is SectionFile => !!f && typeof (f as SectionFile).path === "string" && typeof (f as SectionFile).content === "string",
    );
    const app = files.find((f) => f.path === "src/App.tsx") ?? null;
    return { files: files.filter((f) => f.path !== "src/App.tsx" || f.content.includes(MARKER)), app };
  } catch {
    return null;
  }
}
