import { createHash, randomUUID } from "node:crypto";
import ts from "typescript";
import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { SITE_REPO_DIR, type SiteRow, type SiteSandbox } from "./contract";
import { compareCopyEdit, decodeEntities, literalAttrIsCopy, literalIsCopy } from "./site-light-gate";
import { siteOriginState } from "./sandbox-resolver";
import type { SiteEditRow } from "./site-inline-edits";
import type { SiteEditLease } from "./site-preview-lease";

export const DIRECT_TEXT_MAX_ROWS = 20;
export const DIRECT_TEXT_MAX_CHARS = 1000;
const MAX_FILE_BYTES = 400_000;
const MAX_READ_BYTES = 5_000_000;
const MAX_SCAN_FILES = 1500;
const MAX_TOTAL_BYTES = 1_500_000;
const SANDBOX_TIMEOUT_MS = 30_000;
const SAFE_PATH_RE = /^(?:index\.html|src\/(?:[A-Za-z0-9_@][A-Za-z0-9_.@-]*\/)*[A-Za-z0-9_@][A-Za-z0-9_.@-]*\.(?:tsx|ts|jsx))$/;
const REPO_FULL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;
const RAW_TEXT_TAGS = new Set(["script", "style", "noscript", "template"]);
const SELECTOR_MIN_MATCH = 2;
const READ_MARK = "__ZAVI_TEXT__";
const WRITE_MARK = "__ZAVI_WRITE__";

export type TextEditRow = { row: SiteEditRow; before: string; text: string };
export type CandidateFile = { path: string; content: string };
export type PlannedFile = { path: string; before: string; after: string; rows: TextEditRow[] };

const SUMMARY_QUOTE_MAX = 60;
const SUMMARY_ROWS_MAX = 3;

function quoteForSummary(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return `"${one.length > SUMMARY_QUOTE_MAX ? `${one.slice(0, SUMMARY_QUOTE_MAX - 1).trimEnd()}…` : one}"`;
}

export function directEditSummary(rows: ReadonlyArray<Pick<TextEditRow, "before" | "text">>): string | null {
  const changed = rows.filter((r) => r.before.trim() !== r.text.trim());
  if (changed.length === 0) return null;
  const parts = changed.slice(0, SUMMARY_ROWS_MAX).map((r) => `${quoteForSummary(r.before)} to ${quoteForSummary(r.text)}`);
  const rest = changed.length - parts.length;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Changed ${list}${rest > 0 ? `, and ${rest} more` : ""}`;
}
export type DirectFailure = { row: SiteEditRow; reason: string };
export type TextPlan = { files: PlannedFile[]; failed: DirectFailure[] };

export type CopyGate = (path: string, before: string, after: string, opts: { literals?: boolean }) => { ok: boolean };

type PlaceStep = { tag: string; index: number | null; count: number | null };
type SitePlace = { chain: PlaceStep[]; opaque: boolean };
type TextSite = { path: string; value: string; start: number; end: number; render: (text: string) => string } & SitePlace;

export function normalizeCopy(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function plainObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function emptyFacet(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  const o = plainObject(v);
  return !!o && Object.keys(o).length === 0;
}

export function directTextRow(row: SiteEditRow): TextEditRow | null {
  if (row.removed) return null;
  const patch = plainObject(row.patch);
  if (!patch) return null;
  const before = plainObject(patch.before);
  const text = patch.text;
  const old = before?.text;
  if (typeof text !== "string" || typeof old !== "string") return null;
  for (const [k, v] of Object.entries(patch)) {
    if (k === "text" || k === "before") continue;
    if (!emptyFacet(v)) return null;
  }
  for (const [k, v] of Object.entries(before ?? {})) {
    if (k === "text") continue;
    if (!emptyFacet(v)) return null;
  }
  if (text.length > DIRECT_TEXT_MAX_CHARS || old.length > DIRECT_TEXT_MAX_CHARS) return null;
  if (!normalizeCopy(text) || !normalizeCopy(old) || normalizeCopy(text) === normalizeCopy(old)) return null;
  return { row, before: old, text };
}

export function anchorFor(before: string): string {
  const runs = before.split(/[^A-Za-z0-9]+/).filter((r) => r.length >= 2);
  return runs.reduce((best, r) => (r.length > best.length ? r : best), "");
}

function core(raw: string): { lead: number; trail: number } {
  const lead = raw.length - raw.replace(/^\s+/, "").length;
  const trail = raw.length - raw.replace(/\s+$/, "").length;
  return { lead, trail };
}

function mirrorQuotes(out: string, rawOriginal: string): string {
  const apos = rawOriginal.match(/&apos;|&#39;|&#x27;/i)?.[0];
  const quot = rawOriginal.match(/&quot;|&#34;|&#x22;/i)?.[0];
  let s = out;
  if (apos) s = s.replace(/'/g, apos);
  if (quot) s = s.replace(/"/g, quot);
  return s;
}

export function escapeJsxText(text: string, rawOriginal: string): string {
  const s = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
  return mirrorQuotes(s, rawOriginal);
}

export function escapeHtmlText(text: string, rawOriginal: string): string {
  return mirrorQuotes(text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"), rawOriginal);
}

export function escapeJsxAttr(value: string, quote: string): string {
  const s = value.replace(/&/g, "&amp;");
  return quote === "'" ? s.replace(/'/g, "&#39;") : s.replace(/"/g, "&quot;");
}

export function serializeJsString(value: string, quote: string): string {
  let body = value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  if (quote === "`") body = body.replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  else body = body.split(quote).join(`\\${quote}`);
  return `${quote}${body}${quote}`;
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".ts")) return ts.ScriptKind.TS;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TSX;
}

function intrinsicTag(name: ts.JsxTagNameExpression): string | null {
  const text = ts.isIdentifier(name) ? name.text : null;
  return text && /^[a-z][a-z0-9-]*$/.test(text) ? text : null;
}

function jsxTagName(n: ts.Node): string | null {
  if (ts.isJsxElement(n)) return n.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(n)) return n.tagName.getText();
  return null;
}

function nearestJsxElement(n: ts.Node): ts.JsxElement | null {
  for (let p = n.parent; p; p = p.parent) if (ts.isJsxElement(p)) return p;
  return null;
}

function rendersSameTagIndirectly(container: ts.JsxElement, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (jsxTagName(n) === name && nearestJsxElement(n) === container) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  for (const child of container.children) if (jsxTagName(child) === null) visit(child);
  return found;
}

function jsxPlace(node: ts.Node): SitePlace {
  const chain: PlaceStep[] = [];
  let opaque = false;
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    const name = jsxTagName(n);
    if (name === null) continue;
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      opaque = true;
      continue;
    }
    const container = n.parent;
    const same = container && ts.isJsxElement(container) && !rendersSameTagIndirectly(container, name)
      ? container.children.filter((c) => jsxTagName(c) === name)
      : null;
    chain.push({ tag: name, index: same ? same.indexOf(n as ts.JsxChild) + 1 : null, count: same ? same.length : null });
  }
  return { chain, opaque };
}

type SelectorStep = { tag: string; nth: number | null };

function selectorSteps(selector: string): SelectorStep[] {
  const steps: SelectorStep[] = [];
  for (const part of selector.split(">")) {
    const m = part.trim().match(/^([a-z][a-z0-9-]*)(?::nth-of-type\((\d+)\))?/);
    if (m) steps.push({ tag: m[1], nth: m[2] ? Number(m[2]) : null });
  }
  return steps.reverse();
}

function stepFits(step: SelectorStep, place: PlaceStep): boolean {
  if (step.tag !== place.tag) return false;
  if (place.index === null || place.count === null) return step.nth === null;
  return step.nth === null ? place.count === 1 : place.index === step.nth;
}

function fitsSelector(steps: SelectorStep[], place: SitePlace): boolean {
  let i = 0;
  for (const p of place.chain) if (i < steps.length && stepFits(steps[i], p)) i += 1;
  return i === steps.length;
}

export function pickBySelector<T extends SitePlace>(selector: string, hits: ReadonlyArray<T>): T | null {
  const steps = selectorSteps(selector);
  if (steps.length < SELECTOR_MIN_MATCH || hits.some((h) => h.opaque)) return null;
  const fit = hits.filter((h) => fitsSelector(steps, h));
  return fit.length === 1 ? fit[0] : null;
}

function codeSites(path: string, source: string): TextSite[] | null {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
  if (((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length > 0) return null;
  const sites: TextSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      if (node.containsOnlyTriviaWhiteSpaces) return;
      const raw = source.slice(node.pos, node.end);
      const { lead, trail } = core(raw);
      if (lead + trail >= raw.length) return;
      sites.push({
        path,
        value: normalizeCopy(decodeEntities(raw)),
        start: node.pos + lead,
        end: node.end - trail,
        ...jsxPlace(node),
        render: (text) => escapeJsxText(text, raw),
      });
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const start = node.getStart(sf);
      const quote = source[start];
      const parent = node.parent;
      if (parent && ts.isJsxAttribute(parent)) {
        if (!ts.isStringLiteral(node) || !literalAttrIsCopy(parent.name.getText(sf))) return;
        const value = decodeEntities(source.slice(start + 1, node.end - 1));
        const { lead, trail } = core(value);
        sites.push({
          path,
          value: normalizeCopy(value),
          start,
          end: node.end,
          ...jsxPlace(node),
          render: (text) => `${quote}${escapeJsxAttr(`${value.slice(0, lead)}${text}${value.slice(value.length - trail)}`, quote)}${quote}`,
        });
        return;
      }
      if (!literalIsCopy(node)) return;
      const value = node.text;
      const { lead, trail } = core(value);
      sites.push({
        path,
        value: normalizeCopy(value),
        start,
        end: node.end,
        ...jsxPlace(node),
        render: (text) => serializeJsString(`${value.slice(0, lead)}${text}${value.slice(value.length - trail)}`, quote),
      });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

type HtmlNode = DefaultTreeAdapterTypes.ChildNode | DefaultTreeAdapterTypes.Document;

function htmlStep(node: HtmlNode, el: DefaultTreeAdapterTypes.Element): PlaceStep {
  const parent = (node as { parentNode?: HtmlNode | null }).parentNode;
  const siblings = ((parent as { childNodes?: DefaultTreeAdapterTypes.ChildNode[] } | null | undefined)?.childNodes ?? []).filter(
    (c) => (c as DefaultTreeAdapterTypes.Element).tagName === el.tagName,
  );
  return { tag: el.tagName, index: siblings.indexOf(node as DefaultTreeAdapterTypes.ChildNode) + 1, count: siblings.length };
}

function htmlSites(path: string, source: string): TextSite[] {
  const doc = parse(source, { sourceCodeLocationInfo: true });
  const sites: TextSite[] = [];
  const visit = (node: HtmlNode, raw: boolean, place: SitePlace): void => {
    if (node.nodeName === "#text") {
      const loc = (node as DefaultTreeAdapterTypes.TextNode).sourceCodeLocation;
      if (raw || !loc) return;
      const rawText = source.slice(loc.startOffset, loc.endOffset);
      const { lead, trail } = core(rawText);
      if (lead + trail >= rawText.length) return;
      sites.push({
        path,
        value: normalizeCopy((node as DefaultTreeAdapterTypes.TextNode).value),
        start: loc.startOffset + lead,
        end: loc.endOffset - trail,
        ...place,
        render: (text) => escapeHtmlText(text, rawText),
      });
      return;
    }
    const el = node as DefaultTreeAdapterTypes.Element;
    const childRaw = raw || (!!el.tagName && RAW_TEXT_TAGS.has(el.tagName));
    const children = (node as { childNodes?: DefaultTreeAdapterTypes.ChildNode[] }).childNodes ?? [];
    const childPlace = el.tagName ? { chain: [htmlStep(node, el), ...place.chain], opaque: false } : place;
    for (const c of children) visit(c, childRaw, childPlace);
  };
  visit(doc, false, { chain: [], opaque: false });
  return sites;
}

export function textSitesOf(path: string, source: string): TextSite[] | null {
  try {
    return path === "index.html" ? htmlSites(path, source) : codeSites(path, source);
  } catch {
    return null;
  }
}

function applySites(source: string, edits: Array<{ site: TextSite; text: string }>): string {
  let out = source;
  for (const e of [...edits].sort((a, b) => b.site.start - a.site.start)) {
    out = `${out.slice(0, e.site.start)}${e.site.render(e.text)}${out.slice(e.site.end)}`;
  }
  return out;
}

function countValue(sites: TextSite[], value: string): number {
  return sites.reduce((n, s) => n + (s.value === value ? 1 : 0), 0);
}

export function planTextEdits(
  rows: ReadonlyArray<TextEditRow>,
  files: ReadonlyArray<CandidateFile>,
  otherHits: ReadonlyArray<ReadonlyArray<string>> = [],
  gate: CopyGate = compareCopyEdit,
): TextPlan {
  const failed: DirectFailure[] = [];
  const parsed = new Map<string, TextSite[]>();
  const broken = new Set<string>();
  for (const f of files) {
    const sites = textSitesOf(f.path, f.content);
    if (sites) parsed.set(f.path, sites);
    else broken.add(f.path);
  }
  const picks: Array<{ key: string; site: TextSite; row: TextEditRow }> = [];
  rows.forEach((r, i) => {
    const needle = normalizeCopy(r.before);
    if ((otherHits[i] ?? []).length > 0) {
      failed.push({ row: r.row, reason: "ambiguous" });
      return;
    }
    const brokenHit = files.some(
      (f) => broken.has(f.path) && (normalizeCopy(f.content).includes(needle) || normalizeCopy(decodeEntities(f.content)).includes(needle)),
    );
    if (brokenHit) {
      failed.push({ row: r.row, reason: "unreadable_source" });
      return;
    }
    const hits: TextSite[] = [];
    for (const sites of parsed.values()) for (const s of sites) if (s.value === needle) hits.push(s);
    const site = hits.length === 1 ? hits[0] : hits.length > 1 ? pickBySelector(r.row.selector, hits) : null;
    if (!site) {
      failed.push({ row: r.row, reason: hits.length === 0 ? "no_match" : "many_matches" });
      return;
    }
    if (!SAFE_PATH_RE.test(site.path)) {
      failed.push({ row: r.row, reason: "unsafe_path" });
      return;
    }
    picks.push({ key: `${site.path}\u0000${site.start}`, site, row: r });
  });
  const byFile = new Map<string, Array<{ site: TextSite; row: TextEditRow }>>();
  for (const p of picks) {
    if (picks.filter((q) => q.key === p.key).length > 1) {
      failed.push({ row: p.row.row, reason: "same_element" });
      continue;
    }
    byFile.set(p.site.path, [...(byFile.get(p.site.path) ?? []), p]);
  }
  const out: PlannedFile[] = [];
  for (const [path, edits] of byFile) {
    const before = files.find((f) => f.path === path)!.content;
    const after = applySites(
      before,
      edits.map((e) => ({ site: e.site, text: normalizeCopy(e.row.text) })),
    );
    const verdict = gate(path, before, after, { literals: true });
    const beforeSites = parsed.get(path) ?? [];
    const afterSites = textSitesOf(path, after);
    const landed =
      !!afterSites &&
      afterSites.length === beforeSites.length &&
      edits.every((e) => countValue(afterSites, normalizeCopy(e.row.text)) >= 1);
    if (!verdict.ok || !landed) {
      for (const e of edits) failed.push({ row: e.row.row, reason: verdict.ok ? "did_not_land" : "not_copy" });
      continue;
    }
    out.push({ path, before, after, rows: edits.map((e) => e.row) });
  }
  return { files: out, failed };
}

const READ_SCRIPT = String.raw`const fs = require("fs");
const cp = require("child_process");
const input = JSON.parse(Buffer.from(fs.readFileSync(0, "utf8").trim(), "base64").toString("utf8"));
const rows = input.rows;
const code = [".tsx", ".ts", ".jsx"];
const text = [".js", ".mjs", ".cjs", ".json", ".md", ".mdx", ".html", ".htm", ".txt", ".yml", ".yaml", ".svg", ".vue", ".astro"];
const norm = (s) => s.replace(/\s+/g, " ").trim();
const files = [];
const other = rows.map(() => []);
let scanned = 0;
let total = 0;
let over = false;
function consider(rel, isCode) {
  let st;
  try { st = fs.lstatSync(rel); } catch (e) { return; }
  if (!st.isFile()) return;
  scanned += 1;
  if (scanned > input.max_scan) { over = true; return; }
  if (st.size > input.max_read) { if (isCode) over = true; return; }
  const c = fs.readFileSync(rel, "utf8");
  if (!rows.some((r) => c.includes(r.anchor))) return;
  if (isCode) {
    if (st.size > input.max_file) { over = true; return; }
    total += c.length;
    if (total > input.max_total) { over = true; return; }
    files.push({ path: rel, content: c });
    return;
  }
  const n = norm(c);
  rows.forEach((r, i) => { if (c.includes(r.anchor) && n.includes(r.needle)) other[i].push(rel); });
}
function walk(dir, depth) {
  if (over || depth > 12) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of ents) {
    if (over) return;
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const rel = dir + "/" + e.name;
    if (e.isDirectory()) { walk(rel, depth + 1); continue; }
    if (!e.isFile()) continue;
    const lower = e.name.toLowerCase();
    if (code.some((x) => lower.endsWith(x)) && !lower.endsWith(".d.ts")) consider(rel, true);
    else if (text.some((x) => lower.endsWith(x))) consider(rel, false);
  }
}
walk("src", 0);
walk("public", 0);
consider("index.html", true);
let origin = null;
try { origin = cp.execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch (e) {}
process.stdout.write("${READ_MARK}" + Buffer.from(JSON.stringify({ origin, over, files, other })).toString("base64") + "\n");
`;

const WRITE_SCRIPT = String.raw`const fs = require("fs");
const crypto = require("crypto");
const input = JSON.parse(Buffer.from(fs.readFileSync(0, "utf8").trim(), "base64").toString("utf8"));
const hash = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const say = (m, code) => { process.stdout.write("${WRITE_MARK}" + m + "\n"); process.exit(code); };
const plan = [];
for (const f of input.files) {
  if (typeof f.path !== "string" || f.path.includes("..") || f.path.startsWith("/")) say("bad_path", 2);
  let cur = null;
  try {
    const st = fs.lstatSync(f.path);
    if (!st.isFile()) throw new Error("not a file");
    cur = fs.readFileSync(f.path, "utf8");
  } catch (e) {
    if (input.lenient) continue;
    say("missing", 3);
  }
  const h = hash(cur);
  if (h === hash(f.content)) continue;
  if (!f.from.includes(h)) {
    if (input.lenient) continue;
    say("changed", 4);
  }
  plan.push(f);
}
let written = 0;
for (const f of plan) {
  const tmp = f.path + ".zavi-" + process.pid + ".tmp";
  try {
    const mode = fs.statSync(f.path).mode & 0o777;
    fs.writeFileSync(tmp, f.content, { encoding: "utf8", mode });
    fs.renameSync(tmp, f.path);
    written += 1;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (x) {}
    say("write_failed:" + written, 5);
  }
}
say("ok:" + written, 0);
`;

export function sandboxScriptCommand(script: string, payload: unknown): string {
  const s = Buffer.from(script, "utf8").toString("base64");
  const p = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return `node -e "$(printf '%s' '${s}' | base64 -d)" <<'ZAVI_PAYLOAD_EOF'\n${p}\nZAVI_PAYLOAD_EOF`;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export type SandboxRead = { origin: string | null; over: boolean; files: CandidateFile[]; other: string[][] };

export async function readCandidates(sandbox: SiteSandbox, rows: ReadonlyArray<TextEditRow>): Promise<SandboxRead | null> {
  const payload = {
    rows: rows.map((r) => ({ anchor: anchorFor(r.before), needle: normalizeCopy(r.before) })),
    max_scan: MAX_SCAN_FILES,
    max_read: MAX_READ_BYTES,
    max_file: MAX_FILE_BYTES,
    max_total: MAX_TOTAL_BYTES,
  };
  const r = await sandbox.run(sandboxScriptCommand(READ_SCRIPT, payload), { cwd: SITE_REPO_DIR, timeoutMs: SANDBOX_TIMEOUT_MS });
  if (r.exitCode !== 0) return null;
  const line = r.stdout.split("\n").find((l) => l.startsWith(READ_MARK));
  if (!line) return null;
  try {
    const j = JSON.parse(Buffer.from(line.slice(READ_MARK.length), "base64").toString("utf8")) as Partial<SandboxRead>;
    const files = Array.isArray(j.files)
      ? j.files.filter((f): f is CandidateFile => !!f && typeof f.path === "string" && typeof f.content === "string")
      : [];
    const other = Array.isArray(j.other) ? j.other.map((o) => (Array.isArray(o) ? o.filter((p) => typeof p === "string") : [])) : [];
    return { origin: typeof j.origin === "string" ? j.origin : null, over: j.over === true, files, other };
  } catch {
    return null;
  }
}

export async function writeFiles(
  sandbox: SiteSandbox,
  files: ReadonlyArray<{ path: string; content: string; from: string[] }>,
  lenient = false,
): Promise<{ ok: boolean; detail: string }> {
  const r = await sandbox.run(sandboxScriptCommand(WRITE_SCRIPT, { files, lenient }), { cwd: SITE_REPO_DIR, timeoutMs: SANDBOX_TIMEOUT_MS });
  const line = r.stdout.split("\n").find((l) => l.startsWith(WRITE_MARK));
  const detail = line ? line.slice(WRITE_MARK.length) : `exit_${r.exitCode}`;
  return { ok: r.exitCode === 0 && detail.startsWith("ok:"), detail };
}

export type RepoAuth = { tenant_id: string; installation_id: number; owner: string; repo: string };

export type DirectTextDeps = {
  claimLease: (tenant_id: string, site_id: string) => Promise<SiteEditLease>;
  hasActiveBuild: (tenant_id: string) => Promise<boolean>;
  sandboxFor: (tenant_id: string, site_id: string) => Promise<SiteSandbox | null>;
  repoGate: (tenant_id: string, repo_full_name: string) => Promise<{ ok: boolean; site_id?: string }>;
  installation: (tenant_id: string, repo_full_name: string) => Promise<number>;
  mainHead: (a: RepoAuth) => Promise<string | null>;
  readMainFile: (a: RepoAuth & { sha: string; path: string }) => Promise<string | null>;
  commit: (
    a: RepoAuth & {
      expected_parent_sha: string;
      message: string;
      files: Array<{ path: string; action: "create" | "modify"; content: string; encoding?: "base64" }>;
    },
  ) => Promise<{ commit_sha: string }>;
  reserveChange: (input: { tenant_id: string; id: string; site: SiteRow; label: string; summary?: string | null }) => Promise<void>;
  finishChange: (input: { tenant_id: string; id: string; site: SiteRow; label: string; summary?: string | null; commit_sha: string }) => Promise<void>;
  dropChange: (input: { tenant_id: string; id: string }) => Promise<void>;
  clearRows: (
    tenant_id: string,
    app_id: string,
    rows: ReadonlyArray<Pick<SiteEditRow, "id" | "updated_at">>,
  ) => Promise<{ cleared: number; error?: string }>;
  markSiteEdited?: (tenant_id: string, site_id: string) => Promise<void>;
  alert?: (input: { tenant_id: string; site_id: string; detail: string }) => void;
  log?: (line: Record<string, unknown>) => void;
  now?: () => number;
  gate?: CopyGate;
};

export const DIRECT_TEXT_RECORD_ATTEMPTS = 3;

async function retry<T>(attempts: number, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let error = "";
  for (let i = 0; i < attempts; i++) {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      error = String((e as Error)?.message ?? e).slice(0, 200);
    }
  }
  return { ok: false, error };
}

export async function commitWithChangeRecord(
  input: { tenant_id: string; site: SiteRow; label: string; summary?: string | null; commit: () => Promise<{ commit_sha: string }> },
  deps: Pick<DirectTextDeps, "reserveChange" | "finishChange" | "dropChange" | "alert" | "log">,
): Promise<{ ok: true; commit_sha: string; conductor_run_id: string } | { ok: false; reason: "record_failed" | "persist_failed"; error: string }> {
  const { tenant_id, site, label } = input;
  const summary = input.summary ?? null;
  const log = deps.log ?? ((l) => console.log(JSON.stringify(l)));
  const id = randomUUID();
  const reserved = await retry(DIRECT_TEXT_RECORD_ATTEMPTS, () => deps.reserveChange({ tenant_id, id, site, label, summary }));
  if (!reserved.ok) {
    log({ evt: "site_direct_record_failed", level: "error", tenant_id, site_id: site.id, error: reserved.error });
    await retry(DIRECT_TEXT_RECORD_ATTEMPTS, () => deps.dropChange({ tenant_id, id })).catch(() => undefined);
    return { ok: false, reason: "record_failed", error: reserved.error };
  }
  let commit_sha: string;
  try {
    commit_sha = (await input.commit()).commit_sha;
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 200);
    const dropped = await retry(DIRECT_TEXT_RECORD_ATTEMPTS, () => deps.dropChange({ tenant_id, id }));
    if (!dropped.ok) deps.alert?.({ tenant_id, site_id: site.id, detail: `record ${id} lists a change whose commit failed: ${dropped.error}` });
    return { ok: false, reason: "persist_failed", error };
  }
  const finished = await retry(DIRECT_TEXT_RECORD_ATTEMPTS, () => deps.finishChange({ tenant_id, id, site, label, summary, commit_sha }));
  if (!finished.ok) {
    log({ evt: "site_direct_record_finish_failed", level: "error", tenant_id, site_id: site.id, commit_sha, error: finished.error });
    deps.alert?.({ tenant_id, site_id: site.id, detail: `record ${id} has no sha for commit ${commit_sha}: ${finished.error}` });
  }
  return { ok: true, commit_sha, conductor_run_id: id };
}

export type DirectTextResult = {
  applied: SiteEditRow[];
  fallback: SiteEditRow[];
  conductor_run_id: string | null;
  reason: string | null;
};

export async function applySiteTextEditsDirect(
  input: { tenant_id: string; site: SiteRow; app_id: string; rows: ReadonlyArray<SiteEditRow>; label: (count: number) => string },
  deps: DirectTextDeps,
): Promise<DirectTextResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const log = deps.log ?? ((l) => console.log(JSON.stringify(l)));
  const { tenant_id, site, app_id } = input;
  const steps: Record<string, number> = {};
  let stepAt = started;
  const step = (name: string): void => {
    const at = now();
    steps[name] = at - stepAt;
    stepAt = at;
  };
  const textRows: TextEditRow[] = [];
  for (const row of input.rows) {
    if (textRows.length >= DIRECT_TEXT_MAX_ROWS) break;
    const t = directTextRow(row);
    if (t) textRows.push(t);
  }
  const done = (applied: SiteEditRow[], reason: string | null, conductor_run_id: string | null = null): DirectTextResult => {
    const ids = new Set(applied.map((r) => r.id));
    const fallback = input.rows.filter((r) => !ids.has(r.id));
    log({
      evt: "site_text_direct",
      tenant_id,
      site_id: site.id,
      rows: input.rows.length,
      text_rows: textRows.length,
      applied: applied.length,
      fallback: fallback.length,
      reason,
      ms: now() - started,
      steps,
    });
    return { applied, fallback, conductor_run_id, reason };
  };
  if (textRows.length === 0) return done([], "no_text_rows");
  if (site.tenant_id !== tenant_id) return done([], "not_your_site");
  const repo = (site.github_full_name ?? "").trim();
  if (!REPO_FULL_RE.test(repo)) return done([], "no_repo");

  const [owner, name] = repo.split("/");
  const leaseP = deps.claimLease(tenant_id, site.id).catch((): SiteEditLease => ({ held: "unknown" }));
  const gateP = deps.repoGate(tenant_id, repo).catch(() => ({ ok: false }) as { ok: boolean; site_id?: string });
  const lease = await leaseP;
  step("lease");
  if (!("release" in lease)) return done([], lease.held === "wake" || lease.held === "restart" ? "preview_starting" : "lease_held");
  try {
    if (await deps.hasActiveBuild(tenant_id).catch(() => true)) return done([], "build_active");
    const gate = await gateP;
    step("gate");
    if (!gate.ok || (gate.site_id && gate.site_id !== site.id)) return done([], "repo_gate");
    const sandbox = await deps.sandboxFor(tenant_id, site.id).catch(() => null);
    step("sandbox");
    if (!sandbox) return done([], "sandbox_unavailable");
    const mainP = deps
      .installation(tenant_id, repo)
      .catch(() => null)
      .then(async (installation_id) => {
        if (installation_id === null) return { installation_id, head: null };
        const head = await deps.mainHead({ tenant_id, installation_id, owner, repo: name }).catch(() => null);
        return { installation_id, head };
      });
    const read = await readCandidates(sandbox, textRows).catch(() => null);
    step("read");
    if (!read) return done([], "sandbox_read_failed");
    if (siteOriginState(read.origin, repo) === "foreign") return done([], "foreign_tree");
    if (read.over) return done([], "too_large");

    const plan = planTextEdits(textRows, read.files, read.other, deps.gate);
    if (plan.files.length === 0) return done([], plan.failed[0]?.reason ?? "no_match");

    const { installation_id, head } = await mainP;
    step("main_head");
    if (installation_id === null) return done([], "no_installation");
    const auth: RepoAuth = { tenant_id, installation_id, owner, repo: name };
    if (!head) return done([], "main_unreadable");
    const onMain = await Promise.all(
      plan.files.map((f) => deps.readMainFile({ ...auth, sha: head, path: f.path }).catch(() => null)),
    );
    const files = plan.files.filter((f, i) => onMain[i] === f.before);
    step("main_files");
    if (files.length === 0) return done([], "behind_main");

    const wrote = await writeFiles(
      sandbox,
      files.map((f) => ({ path: f.path, content: f.after, from: [sha256(f.before)] })),
    ).catch((e: unknown) => ({ ok: false, detail: String((e as Error)?.message ?? e).slice(0, 120) }));
    step("write");
    if (!wrote.ok) {
      if (wrote.detail.startsWith("write_failed")) {
        await writeFiles(sandbox, files.map((f) => ({ path: f.path, content: f.before, from: [sha256(f.after)] })), true).catch(() => undefined);
      }
      return done([], `sandbox_write_failed:${wrote.detail}`);
    }

    const applied = files.flatMap((f) => f.rows);
    const label = input.label(applied.length);
    const committed = await commitWithChangeRecord(
      {
        tenant_id,
        site,
        label,
        summary: directEditSummary(applied),
        commit: () =>
          deps.commit({
            ...auth,
            expected_parent_sha: head,
            message: label,
            files: files.map((f) => ({ path: f.path, action: "modify" as const, content: f.after })),
          }),
      },
      { ...deps, log },
    );
    step("commit");
    if (!committed.ok) {
      const reverted = await writeFiles(
        sandbox,
        files.map((f) => ({ path: f.path, content: f.before, from: [sha256(f.after)] })),
        true,
      ).catch(() => ({ ok: false, detail: "revert_threw" }));
      log({ evt: "site_text_direct_persist_failed", tenant_id, site_id: site.id, reason: committed.reason, reverted: reverted.ok, error: committed.error });
      return done([], committed.reason);
    }
    const conductor_run_id = committed.conductor_run_id;
    const appliedRows = applied.map((r) => r.row);
    const [cleared] = await Promise.all([
      deps
        .clearRows(tenant_id, app_id, appliedRows.map((r) => ({ id: r.id, updated_at: r.updated_at })))
        .catch((e: unknown) => ({ cleared: 0, error: String((e as Error)?.message ?? e) })),
      deps.markSiteEdited?.(tenant_id, site.id).catch(() => undefined),
    ]);
    step("clear");
    if (cleared.error) log({ evt: "site_inline_edits_clear_failed", tenant_id, site_id: site.id, error: cleared.error.slice(0, 200) });
    return done(appliedRows, null, conductor_run_id);
  } finally {
    await lease.release().catch(() => undefined);
  }
}

export function realDirectTextDeps(): DirectTextDeps {
  return {
    claimLease: async (tenant_id, site_id) => (await import("./site-preview-lease")).claimSiteEditLease(tenant_id, site_id),
    hasActiveBuild: async (tenant_id) => {
      const { asTenantId, tenantClient } = await import("@/services/tenant-client");
      const { data, error } = await tenantClient(asTenantId(tenant_id))
        .from("conductor_runs")
        .select("id")
        .eq("tenant_id", tenant_id)
        .eq("kind", "build_app")
        .in("status", ["active", "provisioning"])
        .limit(1);
      if (error) return true;
      return ((data as unknown[] | null)?.length ?? 0) > 0;
    },
    sandboxFor: async (tenant_id, site_id) => {
      const [{ createSiteSandboxResolver }, { siteStore }] = await Promise.all([import("./sandbox-resolver"), import("./store")]);
      return createSiteSandboxResolver({ store: siteStore(), recreate: null }).forSite(tenant_id, site_id);
    },
    repoGate: async (tenant_id, repo_full_name) => {
      const { assertProvisionedRepoTarget } = await import("@/services/provisioning/provisioned-repo-gate");
      const gate = await assertProvisionedRepoTarget(tenant_id, repo_full_name);
      return { ok: gate.ok, site_id: (gate as { site_id?: string }).site_id };
    },
    installation: async (tenant_id, repo_full_name) => (await import("@/services/agents/refine-undo")).resolveInstallationForRepo(tenant_id, repo_full_name),
    mainHead: async (a) => (await import("@/services/mcp/internal/github")).readBranchSha({ ...a, branch: "main" }),
    readMainFile: async (a) => {
      const { readFileImpl } = await import("@/services/mcp/internal/github");
      try {
        const r = await readFileImpl(a.tenant_id, a.installation_id, { owner: a.owner, repo: a.repo, ref: a.sha, path: a.path }, MAX_READ_BYTES);
        if (r.truncated) throw new Error("main file too large to compare");
        return r.content;
      } catch (e) {
        if ((e as { code?: unknown })?.code === "not_found") return null;
        throw e;
      }
    },
    commit: async (a) => {
      const { commitFilesToBranch } = await import("@/services/mcp/internal/github");
      const r = await commitFilesToBranch({
        tenant_id: a.tenant_id,
        installation_id: a.installation_id,
        owner: a.owner,
        repo: a.repo,
        branch: "main",
        fallback_base: "main",
        expected_parent_sha: a.expected_parent_sha,
        message: a.message,
        files: a.files,
      });
      return { commit_sha: r.commit_sha };
    },
    reserveChange: async ({ tenant_id, id, site, label, summary }) => {
      const { asTenantId, tenantClient } = await import("@/services/tenant-client");
      const at = new Date().toISOString();
      const { error } = await tenantClient(asTenantId(tenant_id))
        .from("conductor_runs")
        .insert({
          id,
          objective: `[refine] ${label}`.slice(0, 500),
          kind: "build_app",
          status: "done",
          spend_usd: 0,
          max_usd: 0,
          goal_graph: [directChangeNode({ site, label, summary, commit_sha: null, at })],
        });
      if (error && error.code !== "23505") throw new Error(error.message);
    },
    finishChange: async ({ tenant_id, id, site, label, summary, commit_sha }) => {
      const { asTenantId, tenantClient } = await import("@/services/tenant-client");
      const at = new Date().toISOString();
      const { error } = await tenantClient(asTenantId(tenant_id))
        .from("conductor_runs")
        .update({ goal_graph: [directChangeNode({ site, label, summary, commit_sha, at })], created_at: at, updated_at: at })
        .eq("id", id);
      if (error) throw new Error(error.message);
    },
    dropChange: async ({ tenant_id, id }) => {
      const { asTenantId, tenantClient } = await import("@/services/tenant-client");
      const { error } = await tenantClient(asTenantId(tenant_id)).from("conductor_runs").delete().eq("id", id).eq("status", "done");
      if (error) throw new Error(error.message);
    },
    clearRows: async (tenant_id, app_id, rows) => {
      const [{ clearAppliedSiteEdits }, { asTenantId }] = await Promise.all([import("./site-inline-edits"), import("@/services/tenant-client")]);
      return clearAppliedSiteEdits(asTenantId(tenant_id), app_id, rows);
    },
    markSiteEdited: async (tenant_id, site_id) => {
      const { siteStore } = await import("./store");
      await siteStore().update(tenant_id, site_id, { last_edit_at: new Date().toISOString() });
      void import("./site-preview-snapshot-capture").then((m) => m.notePreviewChanged(tenant_id, site_id)).catch(() => undefined);
    },
    alert: ({ tenant_id, site_id, detail }) => {
      void import("@/services/logging/logEvent")
        .then(({ logEvent }) =>
          logEvent({
            level: "error",
            source: "site-text-direct",
            code: "site_text_direct.record_failed",
            tenant_id,
            message: `site ${site_id}: ${detail}`,
          }),
        )
        .catch(() => undefined);
    },
  };
}

export function directChangeNode(input: { site: SiteRow; label: string; summary?: string | null; commit_sha: string | null; at: string }): Record<string, unknown> {
  return {
    id: `site-text-${Date.parse(input.at).toString(36)}`,
    status: "done",
    target_agent_slug: "",
    estimate_usd: 0,
    child_run_id: null,
    started_at: input.at,
    finished_at: input.at,
    payload: {
      stage: "build",
      refine_mode: true,
      small_edit: true,
      site_id: input.site.id,
      parent_conductor_run_id: input.site.root_conductor_run_id,
      target: { github_full_name: input.site.github_full_name, default_branch: "main" },
      user_request: input.label,
      customer_summary: input.summary ?? null,
      stop_at_preview: true,
      direct_text_edit: true,
      direct_commit_sha: input.commit_sha,
    },
  };
}
