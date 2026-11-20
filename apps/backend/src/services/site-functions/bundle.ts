
import { createHash } from "node:crypto";
import { posix } from "node:path";
import ts from "typescript";
import { ENTRY_MODULE, RUNTIME_JS, RUNTIME_MODULE, entrySource } from "./runtime-source";

export interface RepoReader {
  read(path: string): Promise<string | null>;
}

export interface WorkerModule {
  name: string;
  content: string;
}

export interface FunctionsBundle {
  mainModule: string;
  modules: WorkerModule[];
  sha256: string;
}

export class FunctionsBundleError extends Error {
  readonly code = "functions_bundle_invalid";
  constructor(public problems: string[]) {
    super(`site functions cannot be built: ${problems.slice(0, 5).join("; ")}`);
  }
}

export const BUNDLE_LIMITS = { modules: 200, fileBytes: 512 * 1024, totalBytes: 3 * 1024 * 1024 } as const;
const SOURCE_EXT = [".ts", ".mts", ".js", ".mjs"];

export function cleanRepoPath(p: string): string | null {
  if (!p || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return null;
  const n = posix.normalize(p);
  if (n === "." || n.startsWith("../") || n === ".." || n.startsWith("/")) return null;
  const parts = n.split("/");
  if (parts.some((s) => s === "node_modules" || (s.startsWith(".") && s !== "."))) return null;
  return n;
}

const outName = (src: string) => src.replace(/\.(m?ts)$/, ".js").replace(/\.mjs$/, ".js");

function relSpecifier(fromModule: string, toModule: string): string {
  let r = posix.relative(posix.dirname(fromModule), toModule);
  if (!r.startsWith(".")) r = `./${r}`;
  return r;
}

async function resolveImport(reader: RepoReader, fromPath: string, spec: string): Promise<{ path: string; text: string } | null> {
  const base = cleanRepoPath(posix.join(posix.dirname(fromPath), spec));
  if (!base) return null;
  const candidates = SOURCE_EXT.some((e) => base.endsWith(e))
    ? [base, ...(base.endsWith(".js") ? [base.slice(0, -3) + ".ts"] : [])]
    : [...SOURCE_EXT.map((e) => base + e), ...SOURCE_EXT.map((e) => `${base}/index${e}`)];
  for (const c of candidates) {
    const t = await reader.read(c);
    if (t !== null) return { path: c, text: t };
  }
  return null;
}

export function runtimeImports(path: string, text: string): string[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, false, ts.ScriptKind.TS);
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) out.add(node.moduleSpecifier.text);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) out.add(node.moduleSpecifier.text);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      out.add(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      out.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...out];
}

const CJS_GLOBALS = new Set(["require", "module", "exports"]);

export function usesRequire(path: string, text: string): boolean {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const declared = new Set<string>();
  const collect = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) declared.add(node.name.text);
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node)) && node.name) declared.add(node.name.text);
    else if (ts.isImportClause(node) && node.name) declared.add(node.name.text);
    else if ((ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) && ts.isIdentifier(node.name)) declared.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(sf);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      found = true;
      return;
    }
    if (ts.isIdentifier(node) && CJS_GLOBALS.has(node.text) && !declared.has(node.text)) {
      const p = node.parent;
      const isName = (ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node) ||
        (ts.isMethodDeclaration(p) && p.name === node) || (ts.isPropertyDeclaration(p) && p.name === node) ||
        (ts.isPropertySignature(p) && p.name === node) || ts.isTypeReferenceNode(p) || ts.isQualifiedName(p);
      if (!isName) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function specifierTransformer(map: Map<string, string>): ts.TransformerFactory<ts.SourceFile> {
  return (ctx) => {
    const visit: ts.Visitor = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const to = map.get(node.moduleSpecifier.text);
        if (to) {
          if (ts.isImportDeclaration(node)) {
            return ctx.factory.updateImportDeclaration(node, node.modifiers, node.importClause, ctx.factory.createStringLiteral(to), node.attributes);
          }
          return ctx.factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, ctx.factory.createStringLiteral(to), node.attributes);
        }
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length && ts.isStringLiteral(node.arguments[0])) {
        const to = map.get(node.arguments[0].text);
        if (to) return ctx.factory.updateCallExpression(node, node.expression, node.typeArguments, [ctx.factory.createStringLiteral(to), ...node.arguments.slice(1)]);
      }
      return ts.visitEachChild(node, visit, ctx);
    };
    return (sf) => ts.visitNode(sf, visit) as ts.SourceFile;
  };
}

export async function bundleFunctions(reader: RepoReader, names: readonly string[], secrets: readonly string[]): Promise<FunctionsBundle> {
  const problems: string[] = [];
  const entries: Array<{ name: string; path: string; text: string }> = [];
  for (const name of [...names].sort()) {
    let found: { path: string; text: string } | null = null;
    for (const ext of [".ts", ".js"]) {
      const t = await reader.read(`functions/${name}${ext}`);
      if (t !== null) {
        found = { path: `functions/${name}${ext}`, text: t };
        break;
      }
    }
    if (!found) problems.push(`functions/${name}.ts is missing (declared in zavi-site.json functions)`);
    else entries.push({ name, ...found });
  }
  if (problems.length) throw new FunctionsBundleError(problems);

  const sources = new Map<string, string>();
  const queue = entries.map((e) => e.path);
  for (const e of entries) sources.set(e.path, e.text);
  const out: WorkerModule[] = [];
  let total = 0;
  while (queue.length) {
    const path = queue.shift()!;
    const text = sources.get(path)!;
    if (/\.(tsx|jsx)$/.test(path)) {
      problems.push(`${path}: JSX/TSX is not allowed in functions`);
      continue;
    }
    const bytes = Buffer.byteLength(text, "utf8");
    total += bytes;
    if (bytes > BUNDLE_LIMITS.fileBytes) problems.push(`${path} is larger than ${BUNDLE_LIMITS.fileBytes} bytes`);
    const map = new Map<string, string>();
    if (usesRequire(path, text)) problems.push(`${path}: require / module / exports (CommonJS) are not available in functions (use import / export)`);
    for (const spec of runtimeImports(path, text)) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) {
        problems.push(`${path}: import "${spec}" is not allowed (functions may import only relative files in the repo; use fetch for HTTP APIs and the platform object for data and secrets)`);
        continue;
      }
      const r = await resolveImport(reader, path, spec);
      if (!r) {
        problems.push(`${path}: cannot resolve "${spec}" inside the repo`);
        continue;
      }
      if (/\.(tsx|jsx|json)$/.test(r.path)) {
        problems.push(`${path}: "${spec}" is not a .ts/.js module`);
        continue;
      }
      map.set(spec, relSpecifier(outName(path), outName(r.path)));
      if (!sources.has(r.path)) {
        sources.set(r.path, r.text);
        queue.push(r.path);
        if (sources.size > BUNDLE_LIMITS.modules) {
          problems.push(`functions import more than ${BUNDLE_LIMITS.modules} files`);
          queue.length = 0;
          break;
        }
      }
    }
    const result = ts.transpileModule(text, {
      fileName: path,
      reportDiagnostics: true,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        isolatedModules: true,
        verbatimModuleSyntax: false,
        sourceMap: false,
        removeComments: false,
      },
      transformers: { before: [specifierTransformer(map)] },
    });
    for (const d of result.diagnostics ?? []) {
      if (d.category === ts.DiagnosticCategory.Error) problems.push(`${path}: ${ts.flattenDiagnosticMessageText(d.messageText, " ").slice(0, 200)}`);
    }
    out.push({ name: outName(path), content: result.outputText });
  }
  if (total > BUNDLE_LIMITS.totalBytes) problems.push(`function sources exceed ${BUNDLE_LIMITS.totalBytes} bytes`);
  const names_ = new Set(out.map((m) => m.name));
  if (names_.size !== out.length || names_.has(ENTRY_MODULE) || names_.has(RUNTIME_MODULE)) problems.push("two function sources map to the same module name");
  if (problems.length) throw new FunctionsBundleError([...new Set(problems)]);

  const modules: WorkerModule[] = [
    { name: ENTRY_MODULE, content: entrySource(entries.map((e) => ({ name: e.name, module: outName(e.path) })), secrets) },
    { name: RUNTIME_MODULE, content: RUNTIME_JS },
    ...out.sort((a, b) => (a.name < b.name ? -1 : 1)),
  ];
  const h = createHash("sha256");
  for (const m of [...modules].sort((a, b) => (a.name < b.name ? -1 : 1))) h.update(m.name).update("\0").update(m.content).update("\0");
  return { mainModule: ENTRY_MODULE, modules, sha256: h.digest("hex") };
}

export function gitRepoReader(sandbox: { run(cmd: string, o: { cwd: string; timeoutMs: number }): Promise<{ exitCode: number; stdout: string; stderr: string }> }, cwd: string, sha: string): RepoReader {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("gitRepoReader: invalid sha");
  return {
    async read(path) {
      const p = cleanRepoPath(path);
      if (!p || !/^[A-Za-z0-9._/-]+$/.test(p)) return null;
      const r = await sandbox.run(`git cat-file -e ${sha}:${p} 2>/dev/null && git show ${sha}:${p}`, { cwd, timeoutMs: 60_000 });
      return r.exitCode === 0 ? r.stdout : null;
    },
  };
}
