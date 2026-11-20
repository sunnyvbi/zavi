import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const DASH = /—|&mdash;|&#8212;|&#x2014;/i;

const PLACEHOLDERS = new Set(["—", "—%", "— credits", "— credits used", "— set a target"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return d.name === "node_modules" || d.name === "__tests__" ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(d.name) && !/\.(test|spec)\.tsx?$/.test(d.name) && !d.name.endsWith(".d.ts") ? [p] : [];
  });
}

function insideConsoleCall(n: ts.Node, sf: ts.SourceFile): boolean {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && p.expression.getText(sf).startsWith("console.")) return true;
    if (ts.isBlock(p) || ts.isSourceFile(p)) return false;
  }
  return false;
}

function isSourcedQuote(node: ts.Node): boolean {
  const parent = node.parent;
  return ts.isPropertyAssignment(parent) && parent.name.getText() === "quote" &&
    ts.isObjectLiteralExpression(parent.parent) && parent.parent.properties.some((property) =>
      ts.isPropertyAssignment(property) && property.name.getText() === "sourceUrl" &&
      ts.isStringLiteral(property.initializer) && /^https?:\/\//.test(property.initializer.text),
    );
}

function emDashCopy(file: string, text = readFileSync(file, "utf8")): string[] {
  if (!DASH.test(text) && !/\\u2014|\\u\{2014\}/i.test(text)) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: string[] = [];
  const visit = (n: ts.Node) => {
    const literal =
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n) ||
      ts.isJsxText(n);
    if (literal) {
      const value = (n as ts.LiteralLikeNode).text;
      const copy = value.replace(/“—”/g, "");
      if (DASH.test(copy) && !PLACEHOLDERS.has(value.trim()) && !insideConsoleCall(n, sf) && !isSourcedQuote(n)) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        hits.push(`${relative(SRC, file)}:${line} ${JSON.stringify(value.trim().slice(0, 80))}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

describe("no em dash in web copy", () => {
  it("authored copy in apps/web/src is written without an em dash", () => {
    const hits = sourceFiles(SRC).flatMap((f) => emDashCopy(f));
    expect(hits).toEqual([]);
  });

  it("catches copy, and lets placeholders, regexes, comments and console output through", () => {
    const sample = [
      'const a = "Saved — refresh to see it";',
      "const b = <p>Nothing is lost — try again.</p>;",
      "const c = `${n} — workspace home`;",
      'const ok1 = value ?? "—";',
      "const ok2 = <td>—</td>;",
      "const ok3 = /\\s+[—-]\\s+/;",
      "// a comment — fine",
      'console.warn("degraded — falling back");',
      'const ok4 = "—%";',
      'console.warn(format("degraded — falling back"));',
      'const d = "Saved \\u2014 again";',
      'const source = { quote: "Quoted — words", sourceUrl: "https://example.com/source" };',
    ].join("\n");
    const hits = emDashCopy("/x/sample.tsx", sample).map((h) => h.split(" ").slice(1).join(" "));
    expect(hits).toEqual(['"Saved — refresh to see it"', '"Nothing is lost — try again."', '"— workspace home"', '"Saved — again"']);
  });
});
