
import ts from "typescript";
import { parse } from "parse5";
import { pinnedLookup } from "@/services/sites/pinned-image-fetch";
import type { CopyBlock } from "./seo-open-pr";

const COPY_CODE_CHARS = /['"`=;{}<>\\$]/;
const NEW_TEXT_ALLOWED = /^[\p{L}\p{N} \t\n.,!?\-:()&%/\u2018\u2019\u201C\u201D]*$/u;

export const typographicApostrophes = (s: string): string => s.replace(/'/g, "\u2019");

export function copyBlockProblem(current: string, next: string): string | null {
  if (COPY_CODE_CHARS.test(current)) {
    return "The current text holds quotes or code characters (' \" ` = ; { } < > \\ $), so Zavi can't change it safely in code. File it as a manual step with that reason.";
  }
  if (!isProse(current) || !isProse(next)) return "Page copy must be prose, at least two words with a space, in both the current and the new text. File it as a manual step otherwise.";
  if (!NEW_TEXT_ALLOWED.test(next)) {
    return "New page copy may carry only letters, digits, spaces, . , ! ? - : ( ) & % / and typographic quotes (\u2019 \u2018 \u201C \u201D).";
  }
  return null;
}

export function isProse(text: string): boolean {
  return /\s/.test(text) && (text.match(/[\p{L}\p{N}]+/gu) ?? []).length >= 2;
}

export const PAGE_COPY_NOT_PLAIN_TEXT =
  "This text sits in code, not in plain page text, so Zavi did not open a pull request and nothing in your repository changed. Change it by hand.";

const TS_KINDS: Record<string, ts.ScriptKind> = { ".ts": ts.ScriptKind.TS, ".tsx": ts.ScriptKind.TSX, ".js": ts.ScriptKind.JS, ".jsx": ts.ScriptKind.JSX, ".mjs": ts.ScriptKind.JS };
const HTML_FILES = new Set([".html", ".htm"]);

const extOf = (path: string): string => {
  const m = /(\.[a-z0-9]+)$/i.exec(path);
  return m ? m[1]!.toLowerCase() : "";
};

function occurrences(base: string, text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let at = base.indexOf(text); at >= 0; at = base.indexOf(text, at + 1)) out.push([at, at + text.length]);
  return out;
}

const TEXT_ATTRIBUTES = new Set(["alt", "title", "placeholder", "aria-label", "aria-description", "label"]);

function isTextString(n: ts.Node): boolean {
  let p: ts.Node | undefined = n.parent;
  while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isConditionalExpression(p) || ts.isBinaryExpression(p))) {
    if (ts.isBinaryExpression(p) && p.operatorToken.kind !== ts.SyntaxKind.BarBarToken && p.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken && p.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) return false;
    p = p.parent;
  }
  if (!p) return false;
  if (ts.isJsxAttribute(p)) return TEXT_ATTRIBUTES.has(p.name.getText());
  const shape =
    ts.isJsxExpression(p) ||
    ts.isArrayLiteralExpression(p) ||
    ts.isReturnStatement(p) ||
    ts.isArrowFunction(p) ||
    (ts.isPropertyAssignment(p) && p.initializer.pos <= n.pos) ||
    (ts.isVariableDeclaration(p) && p.initializer !== undefined && p.initializer.pos <= n.pos);
  if (!shape) return false;
  for (let a: ts.Node | undefined = p; a; a = a.parent) {
    if (ts.isCallExpression(a) || ts.isNewExpression(a) || ts.isTaggedTemplateExpression(a) || ts.isDecorator(a) || ts.isJsxSpreadAttribute(a)) return false;
    if (ts.isJsxExpression(a)) return !!a.parent && (ts.isJsxElement(a.parent) || ts.isJsxFragment(a.parent) || (ts.isJsxAttribute(a.parent) && TEXT_ATTRIBUTES.has(a.parent.name.getText())));
  }
  return true;
}

const CODE_ELEMENTS = new Set(["script", "style"]);

function importsNextScript(sf: ts.SourceFile): boolean {
  return sf.statements.some((st) => ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === "next/script");
}

function inCodeJsx(n: ts.Node): boolean {
  for (let a: ts.Node | undefined = n.parent; a; a = a.parent) {
    if (ts.isJsxSpreadAttribute(a)) return true;
    if (ts.isJsxAttribute(a) && !TEXT_ATTRIBUTES.has(a.name.getText())) return true;
    if (ts.isJsxElement(a) || ts.isJsxSelfClosingElement(a)) {
      const tag = (ts.isJsxElement(a) ? a.openingElement : a).tagName.getText();
      if (CODE_ELEMENTS.has(tag.split(".").pop()!.toLowerCase())) return true;
    }
  }
  return false;
}

function codeTextRanges(path: string, base: string, kind: ts.ScriptKind): Array<[number, number, boolean]> {
  const sf = ts.createSourceFile(path, base, ts.ScriptTarget.Latest, true, kind);
  const out: Array<[number, number, boolean]> = [];
  if (importsNextScript(sf)) return out;
  const visit = (n: ts.Node): void => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && isTextString(n) && !inCodeJsx(n)) {
      out.push([n.getStart(sf) + 1, n.getEnd() - 1, ts.isNoSubstitutionTemplateLiteral(n)]);
    } else if (ts.isJsxText(n) && !inCodeJsx(n)) {
      out.push([n.getStart(sf), n.getEnd(), true]);
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

const NON_TEXT_ELEMENTS = new Set(["script", "style", "template", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext", "head"]);

export const HTML_MAX_TAGS = 30_000;

type HtmlTextNode = { start: number; end: number; value: string };

function htmlTextNodes(html: string): HtmlTextNode[] | null {
  if (html.length > PAGE_HTML_CAP) return null;
  let tags = 0;
  for (let at = html.indexOf("<"); at >= 0; at = html.indexOf("<", at + 1)) if (++tags > HTML_MAX_TAGS) return null;
  const out: HtmlTextNode[] = [];
  type Node = { nodeName: string; value?: string; childNodes?: Node[]; sourceCodeLocation?: { startOffset: number; endOffset: number } | null };
  const stack: Node[] = [parse(html, { sourceCodeLocationInfo: true }) as unknown as Node];
  while (stack.length) {
    const n = stack.pop()!;
    if (NON_TEXT_ELEMENTS.has(n.nodeName)) continue;
    const loc = n.sourceCodeLocation;
    if (n.nodeName === "#text" && loc && !html.slice(loc.startOffset, loc.endOffset).includes("<")) {
      out.push({ start: loc.startOffset, end: loc.endOffset, value: n.value ?? "" });
    }
    const kids = n.childNodes ?? [];
    for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]!);
  }
  return out;
}

function hostRange<T extends readonly [number, number, ...unknown[]]>(sorted: ReadonlyArray<T>, s0: number, e0: number): T | undefined {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = sorted[mid]!;
    if (r[1] <= s0) lo = mid + 1;
    else if (r[0] > s0) hi = mid - 1;
    else return e0 <= r[1] ? r : undefined;
  }
  return undefined;
}

export function pageTextProblem(path: string, base: string, blocks: ReadonlyArray<CopyBlock>): string | null {
  const ext = extOf(path);
  const tsKind = TS_KINDS[ext];
  if (tsKind === undefined && !HTML_FILES.has(ext)) return `${ext || "this kind of"} file is not one Zavi changes page text in`;
  let text: Array<[number, number, boolean]> = [];
  try {
    if (tsKind !== undefined) text = codeTextRanges(path, base, tsKind);
    else text = (htmlTextNodes(base) ?? []).map((n): [number, number, boolean] => [n.start, n.end, true]);
  } catch {
    return "the file could not be read as code";
  }
  text.sort((x, y) => x[0] - y[0]);
  for (const b of blocks) {
    const occ = occurrences(base, b.current_text);
    if (occ.length === 0) return "a current text is not in the file";
    for (const [s0, e0] of occ) {
      const host = hostRange(text, s0, e0);
      if (!host) return tsKind !== undefined ? "a current text is not wholly inside one page-text string or JSX text" : "a current text touches markup or code";
      if (!host[2] && /[\r\n]/.test(b.new_text)) return "the new text has a line break, and the current text sits in a one-line string";
    }
  }
  return null;
}

export const PAGE_COPY_NOT_ONE_FILE = "The text was not found in one file, or the change touched more than that text, so no pull request was opened and nothing in your repository changed.";

export type ProposedFile = { path?: unknown; action?: unknown; content?: unknown };

export function pageCopyTarget(proposal: { files?: unknown; per_base_files?: unknown; base_branches?: unknown }): { path: string; content: string } | { problem: string } {
  const files = Array.isArray(proposal.files) ? (proposal.files as ProposedFile[]) : [];
  if (files.length !== 1) return { problem: `changes ${files.length} files` };
  const f = files[0]!;
  if (f.action !== "modify" || typeof f.path !== "string" || !f.path || typeof f.content !== "string") return { problem: "is not one modified file" };
  const bases = Array.isArray(proposal.base_branches) ? proposal.base_branches.length : 0;
  if (bases > 1 || (proposal.per_base_files && typeof proposal.per_base_files === "object" && Object.keys(proposal.per_base_files).length > 0)) {
    return { problem: "targets more than one branch" };
  }
  return { path: f.path, content: f.content };
}

export function pageCopyContentProblem(base: string, after: string, blocks: ReadonlyArray<CopyBlock>): string | null {
  let expected = base;
  for (const b of blocks) {
    const first = base.indexOf(b.current_text);
    if (first < 0) return "a current text is not in the file";
    if (base.indexOf(b.current_text, first + 1) >= 0) return "a current text is in the file more than once";
  }
  for (const b of blocks) expected = expected.split(b.current_text).join(b.new_text);
  return expected === after ? null : "the file changes more than the named text";
}

export const PAGE_COPY_READ_FAILED =
  "Zavi could not read the file on GitHub to check this change, so no pull request was opened and nothing in your repository changed. Press Try again.";

export const PAGE_COPY_APPROVER_GONE =
  "The person who approved this is no longer an owner or admin of the workspace, so no pull request was opened. An owner or admin can approve it again.";

export const PAGE_COPY_NOT_ON_PAGE =
  "This text is not on the live page as your site serves it, so Zavi did not open a pull request and nothing in your repository changed. Change it by hand if it is page text.";

export const PAGE_HTML_CAP = 3 * 1024 * 1024;

type PinnedGet = (url: URL, ip: string, family: 4 | 6, signal: AbortSignal) => Promise<{ status: number; location: string | null; body: string }>;

export const PAGE_FETCH_DEADLINE_MS = 10_000;

const pinnedGet: PinnedGet = async (url, ip, family, signal) => {
  const https = await import("node:https");
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("page read deadline passed"));
      return;
    }
    const req = https.request(
      {
        protocol: "https:",
        hostname: url.hostname,
        servername: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { "user-agent": "ZaviBot/1.0 (+https://www.zaviagent.com; page-copy check)", accept: "text/html" },
        lookup: pinnedLookup(ip, family),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        if (status >= 300 && status < 400) {
          res.destroy();
          resolve({ status, location, body: "" });
          return;
        }
        const declared = Number(res.headers["content-length"] ?? NaN);
        if (Number.isFinite(declared) && declared > PAGE_HTML_CAP) {
          res.destroy();
          reject(new Error("page too large"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > PAGE_HTML_CAP) {
            res.destroy();
            reject(new Error("page too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status, location, body: Buffer.concat(chunks).toString("utf-8") }));
        res.on("error", reject);
      },
    );
    const onAbort = () => {
      req.destroy(new Error("page read deadline passed"));
      reject(new Error("page read deadline passed"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    req.on("close", () => signal.removeEventListener("abort", onAbort));
    req.on("error", reject);
    req.end();
  });
};

export const __pinnedGetForTest: PinnedGet = (url, ip, family, signal) => pinnedGet(url, ip, family, signal);

export type PageFetchDeps = {
  resolve: (host: string) => Promise<Array<{ address: string; family: number }>>;
  isPrivate: (ip: string) => boolean;
  get: PinnedGet;
};

const livePageFetch = async (): Promise<PageFetchDeps> => ({
  resolve: async (host) => (await import("node:dns")).promises.lookup(host, { all: true, verbatim: true }),
  isPrivate: (await import("@/services/onboarding/enrichment/url-guard")).isPrivateIp,
  get: pinnedGet,
});

export async function fetchPageHtml(url: string, depsIn?: PageFetchDeps, deadlineMs: number = PAGE_FETCH_DEADLINE_MS): Promise<string> {
  const deps = depsIn ?? (await livePageFetch());
  const signal = AbortSignal.timeout(deadlineMs);
  const site = new URL(url).hostname.replace(/^www\./, "");
  let current = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    if (current.protocol !== "https:" || current.username || current.password) throw new Error("not an https page");
    if (current.hostname.replace(/^www\./, "") !== site) throw new Error("redirected off the site");
    const addrs = await Promise.race([
      deps.resolve(current.hostname),
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new Error("page read deadline passed"));
        signal.addEventListener("abort", () => reject(new Error("page read deadline passed")), { once: true });
      }),
    ]);
    if (addrs.length === 0 || addrs.some((a) => deps.isPrivate(a.address))) throw new Error("not a public address");
    const pick = addrs[0]!;
    if (signal.aborted) throw new Error("page read deadline passed");
    const r = await deps.get(current, pick.address, pick.family === 6 ? 6 : 4, signal);
    if (r.status >= 300 && r.status < 400) {
      if (!r.location) throw new Error("redirect without a location");
      current = new URL(r.location, current);
      continue;
    }
    if (r.status < 200 || r.status >= 300) throw new Error(`page HTTP ${r.status}`);
    return r.body;
  }
  throw new Error("too many redirects");
}

export function visibleText(html: string): string {
  try {
    return normalizeSpace((htmlTextNodes(html) ?? []).map((n) => n.value).join(" "));
  } catch {
    return "";
  }
}
const normalizeSpace = (s: string): string => s.replace(/\s+/g, " ").trim();

export type PageCopyCheckDeps = {
  pageHtml: (url: string) => Promise<string>;
  headSha: (tenant_id: string, repo: string, branch: string) => Promise<string>;
  readFile: (tenant_id: string, repo: string, sha: string, path: string) => Promise<string>;
  role: (user_id: string, tenant_id: string) => Promise<string | null>;
};

const github = async (tenant_id: string, repo: string) => {
  const [owner, name] = repo.split("/");
  const gh = await import("@/services/mcp/internal/github");
  await gh.assertReadRepoMembership(tenant_id, owner!, name!);
  return { gh, owner: owner!, name: name!, installation: await gh.resolveInstallationId(tenant_id) };
};

const liveDeps: PageCopyCheckDeps = {
  pageHtml: (url) => fetchPageHtml(url),
  headSha: async (tenant_id, repo, branch) => {
    const g = await github(tenant_id, repo);
    return g.gh.readBranchHeadSha(tenant_id, g.installation, g.owner, g.name, branch);
  },
  readFile: async (tenant_id, repo, sha, path) => {
    const g = await github(tenant_id, repo);
    const r = await g.gh.readFileImpl(tenant_id, g.installation, { owner: g.owner, repo: g.name, ref: sha, path }, 5 * 1024 * 1024);
    if (r.truncated) throw new Error("file too large to check");
    return r.content;
  },
  role: async (user_id, tenant_id) => (await import("@/services/auth/tenant-role")).loadTenantRoleFor(user_id, tenant_id),
};

export async function checkPageCopyPr(
  tenant_id: string,
  repo: string,
  proposal: { files?: unknown; per_base_files?: unknown; base_branches?: unknown; base_branch?: unknown },
  blocks: ReadonlyArray<CopyBlock>,
  approved_by: string | null,
  page_url: string | null,
  deps: PageCopyCheckDeps = liveDeps,
): Promise<{ refusal: string; why: string } | { base_sha: string }> {
  let role: string | null = null;
  try {
    role = approved_by ? await deps.role(approved_by, tenant_id) : null;
  } catch {
    return { refusal: PAGE_COPY_READ_FAILED, why: "approver role unreadable" };
  }
  if (role !== "owner" && role !== "admin") return { refusal: PAGE_COPY_APPROVER_GONE, why: `approver role ${role ?? "none"}` };
  for (const [i, b] of blocks.entries()) {
    const bad = copyBlockProblem(b.current_text, b.new_text);
    if (bad) return { refusal: PAGE_COPY_NOT_PLAIN_TEXT, why: bad };
    if (blocks.some((o, j) => j !== i && (b.new_text.includes(o.current_text) || normalizeSpace(o.current_text).includes(normalizeSpace(b.current_text))))) {
      return { refusal: PAGE_COPY_NOT_PLAIN_TEXT, why: "blocks overlap or chain" };
    }
  }
  const target = pageCopyTarget(proposal);
  if ("problem" in target) return { refusal: PAGE_COPY_NOT_ONE_FILE, why: target.problem };
  if (!page_url || !/^https:\/\//.test(page_url)) return { refusal: PAGE_COPY_NOT_ON_PAGE, why: "no page" };
  let page: string;
  try {
    page = visibleText(await deps.pageHtml(page_url));
  } catch (e) {
    return { refusal: PAGE_COPY_READ_FAILED, why: `could not read the page: ${(e as Error).message}` };
  }
  for (const b of blocks) if (!page.includes(normalizeSpace(b.current_text))) return { refusal: PAGE_COPY_NOT_ON_PAGE, why: "current text not on the live page" };
  const branch = typeof proposal.base_branch === "string" && proposal.base_branch ? proposal.base_branch : "main";
  let base: string;
  let base_sha: string;
  try {
    base_sha = await deps.headSha(tenant_id, repo, branch);
    base = await deps.readFile(tenant_id, repo, base_sha, target.path);
  } catch (e) {
    return { refusal: PAGE_COPY_READ_FAILED, why: `could not read ${target.path}: ${(e as Error).message}` };
  }
  const structure = pageTextProblem(target.path, base, blocks);
  if (structure) return { refusal: PAGE_COPY_NOT_PLAIN_TEXT, why: structure };
  const problem = pageCopyContentProblem(base, target.content, blocks);
  return problem ? { refusal: PAGE_COPY_NOT_ONE_FILE, why: problem } : { base_sha };
}
