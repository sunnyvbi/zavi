
import path from "node:path";
import { Parser, Language, type Node } from "web-tree-sitter";
import type { RefRow, SymbolRow } from "./types";

type Grammar = "typescript" | "tsx" | "javascript" | "swift" | "kotlin";

let initPromise: Promise<void> | null = null;
const languageCache = new Map<Grammar, Language>();

function grammarWasmPath(grammar: Grammar): string {
  const pkgDir = path.dirname(require.resolve("tree-sitter-wasms/package.json"));
  return path.join(pkgDir, "out", `tree-sitter-${grammar}.wasm`);
}

async function loadLanguage(grammar: Grammar): Promise<Language> {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
  const cached = languageCache.get(grammar);
  if (cached) return cached;
  const lang = await Language.load(grammarWasmPath(grammar));
  languageCache.set(grammar, lang);
  return lang;
}

export function grammarForFile(filePath: string): Grammar | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".jsx":
      return "javascript";
    case ".swift":
      return "swift";
    case ".kt":
    case ".kts":
      return "kotlin";
    default:
      return null;
  }
}

const MAX_SIGNATURE_LEN = 300;

function startLine(node: Node): number {
  return node.startPosition.row + 1;
}
function endLine(node: Node): number {
  return node.endPosition.row + 1;
}

function signatureOf(node: Node): string {
  const firstLine = node.text.split("\n", 1)[0]?.trim() ?? "";
  return firstLine.slice(0, MAX_SIGNATURE_LEN);
}

function nameField(node: Node): Node | null {
  return node.childForFieldName("name");
}

function declaratorKind(declNode: Node): "const" | "var" {
  for (let i = 0; i < declNode.childCount; i++) {
    const c = declNode.child(i);
    if (!c) continue;
    if (c.type === "const") return "const";
    if (c.type === "let" || c.type === "var") return "var";
  }
  return declNode.type === "variable_declaration" ? "var" : "var";
}

interface WalkCtx {
  filePath: string;
  symbols: SymbolRow[];
  refs: RefRow[];
}

function emitSymbol(
  ctx: WalkCtx,
  node: Node,
  name: string,
  kind: SymbolRow["kind"],
): void {
  if (!name) return;
  ctx.symbols.push({
    symbol_name: name,
    kind,
    file_path: ctx.filePath,
    start_line: startLine(node),
    end_line: endLine(node),
    signature: signatureOf(node),
  });
}

function emitRef(
  ctx: WalkCtx,
  node: Node,
  name: string,
  refKind: RefRow["ref_kind"],
  fromSymbol: string | null,
): void {
  if (!name) return;
  ctx.refs.push({
    symbol_name: name,
    ref_kind: refKind,
    from_symbol: fromSymbol,
    file_path: ctx.filePath,
    line: startLine(node),
  });
}

function walk(
  node: Node,
  ctx: WalkCtx,
  enclosing: string | null,
  skipAsRef: Set<number>,
): void {
  let nextEnclosing = enclosing;

  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration": {
      const n = nameField(node);
      if (n) {
        emitSymbol(ctx, node, n.text, "function");
        skipAsRef.add(n.startIndex);
        nextEnclosing = n.text;
      }
      break;
    }
    case "method_definition": {
      const n = nameField(node);
      if (n) {
        emitSymbol(ctx, node, n.text, "method");
        skipAsRef.add(n.startIndex);
        nextEnclosing = n.text;
      }
      break;
    }
    case "class_declaration":
    case "abstract_class_declaration": {
      const n = nameField(node);
      if (n) {
        emitSymbol(ctx, node, n.text, "class");
        skipAsRef.add(n.startIndex);
        nextEnclosing = n.text;
      }
      break;
    }
    case "interface_declaration": {
      const n = nameField(node);
      if (n) {
        emitSymbol(ctx, node, n.text, "interface");
        skipAsRef.add(n.startIndex);
        nextEnclosing = n.text;
      }
      break;
    }
    case "type_alias_declaration": {
      const n = nameField(node);
      if (n) {
        emitSymbol(ctx, node, n.text, "type");
        skipAsRef.add(n.startIndex);
        nextEnclosing = n.text;
      }
      break;
    }
    case "lexical_declaration":
    case "variable_declaration": {
      const kind = declaratorKind(node);
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child || child.type !== "variable_declarator") continue;
        const n = child.childForFieldName("name");
        if (n && (n.type === "identifier" || n.type === "type_identifier")) {
          emitSymbol(ctx, child, n.text, kind);
          skipAsRef.add(n.startIndex);
        }
      }
      break;
    }
    case "call_expression": {
      const fn = node.childForFieldName("function");
      if (fn) {
        if (fn.type === "identifier") {
          emitRef(ctx, fn, fn.text, "call", enclosing);
          skipAsRef.add(fn.startIndex);
        } else if (fn.type === "member_expression") {
          const prop = fn.childForFieldName("property");
          if (prop) {
            emitRef(ctx, prop, prop.text, "call", enclosing);
            skipAsRef.add(prop.startIndex);
          }
        }
      }
      break;
    }
    case "identifier":
    case "type_identifier": {
      if (!skipAsRef.has(node.startIndex)) {
        emitRef(ctx, node, node.text, "reference", enclosing);
      }
      break;
    }
    default:
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walk(child, ctx, nextEnclosing, skipAsRef);
  }
}

const NAME_SKIP_SUBTREE = /(_body|_value_parameters|value_arguments|function_body)$/;

function firstIdentIn(node: Node): Node | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === "simple_identifier" || c.type === "type_identifier") return c;
    if (NAME_SKIP_SUBTREE.test(c.type)) continue;
    const d = firstIdentIn(c);
    if (d) return d;
  }
  return null;
}

function pickName(node: Node): Node | null {
  const f = node.childForFieldName("name");
  if (f) {
    if (f.type === "simple_identifier" || f.type === "type_identifier") return f;
    const inner = firstIdentIn(f);
    return inner ?? f;
  }
  return firstIdentIn(node);
}

function classKeywordKind(node: Node): SymbolRow["kind"] {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c || c.isNamed) continue;
    switch (c.type) {
      case "struct":
        return "struct";
      case "enum":
        return "enum";
      case "extension":
        return "extension";
      case "protocol":
        return "protocol";
      case "interface":
        return "interface";
      case "actor":
      case "class":
        return "class";
      default:
        break;
    }
  }
  return "class";
}

function bindingKind(node: Node): "const" | "var" {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === "value_binding_pattern" || c.type === "binding_pattern_kind") {
      const t = c.text.trim();
      return t.startsWith("let") || t.startsWith("val") ? "const" : "var";
    }
  }
  return "var";
}

function firstNamedChild(node: Node): Node | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.isNamed) return c;
  }
  return null;
}

function childOfType(node: Node, type: string): Node | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === type) return c;
  }
  return null;
}

function emitCallExpr(
  ctx: WalkCtx,
  node: Node,
  enclosing: string | null,
  skipAsRef: Set<number>,
): void {
  const callee = firstNamedChild(node);
  if (!callee) return;
  if (callee.type === "simple_identifier") {
    emitRef(ctx, callee, callee.text, "call", enclosing);
    skipAsRef.add(callee.startIndex);
  } else if (callee.type === "navigation_expression") {
    const suffix = childOfType(callee, "navigation_suffix");
    const id = suffix ? childOfType(suffix, "simple_identifier") : null;
    if (id) {
      emitRef(ctx, id, id.text, "call", enclosing);
      skipAsRef.add(id.startIndex);
    }
  }
}

function walkNonTs(
  node: Node,
  ctx: WalkCtx,
  enclosing: string | null,
  skipAsRef: Set<number>,
): void {
  let nextEnclosing = enclosing;

  switch (node.type) {
    case "class_declaration": {
      const n = pickName(node);
      if (n) {
        emitSymbol(ctx, node, n.text, classKeywordKind(node));
        skipAsRef.add(n.startIndex);
        nextEnclosing = n.text;
      }
      break;
    }
    case "object_declaration": {
      const n = pickName(node);
      if (n) {
        emitSymbol(ctx, node, n.text, "object");
        skipAsRef.add(n.startIndex);
        nextEnclosing = n.text;
      }
      break;
    }
    case "protocol_declaration": {
      const n = pickName(node);
      if (n) {
        emitSymbol(ctx, node, n.text, "protocol");
        skipAsRef.add(n.startIndex);
        nextEnclosing = n.text;
      }
      break;
    }
    case "function_declaration":
    case "protocol_function_declaration": {
      const n = pickName(node);
      if (n) {
        emitSymbol(ctx, node, n.text, "function");
        skipAsRef.add(n.startIndex);
        nextEnclosing = n.text;
      }
      break;
    }
    case "property_declaration": {
      const kind = bindingKind(node);
      const n = pickName(node);
      if (n) {
        emitSymbol(ctx, node, n.text, kind);
        skipAsRef.add(n.startIndex);
      }
      break;
    }
    case "enum_entry": {
      const n = pickName(node);
      if (n) {
        emitSymbol(ctx, node, n.text, "const");
        skipAsRef.add(n.startIndex);
      }
      break;
    }
    case "call_expression": {
      emitCallExpr(ctx, node, enclosing, skipAsRef);
      break;
    }
    case "simple_identifier":
    case "type_identifier": {
      if (!skipAsRef.has(node.startIndex)) {
        emitRef(ctx, node, node.text, "reference", enclosing);
      }
      break;
    }
    default:
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkNonTs(child, ctx, nextEnclosing, skipAsRef);
  }
}

export interface ParsedFile {
  symbols: SymbolRow[];
  refs: RefRow[];
}

export async function parseFile(filePath: string, source: string): Promise<ParsedFile> {
  const grammar = grammarForFile(filePath);
  if (!grammar) return { symbols: [], refs: [] };

  const lang = await loadLanguage(grammar);
  const parser = new Parser();
  parser.setLanguage(lang);

  const tree = parser.parse(source);
  try {
    if (!tree) return { symbols: [], refs: [] };
    const ctx: WalkCtx = { filePath, symbols: [], refs: [] };
    const walker = grammar === "swift" || grammar === "kotlin" ? walkNonTs : walk;
    walker(tree.rootNode, ctx, null, new Set<number>());
    return { symbols: ctx.symbols, refs: ctx.refs };
  } finally {
    tree?.delete();
    parser.delete();
  }
}
