import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]{1,9}|#\d{2,6}|#x[0-9a-fA-F]{2,5});/;
const HTML_WRITER_FNS = new Set(["escapeHtml"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return d.name === "node_modules" ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(d.name) && !/\.(test|spec)\.tsx?$/.test(d.name) ? [p] : [];
  });
}

function entityStrings(file: string): string[] {
  const text = readFileSync(file, "utf8");
  if (!ENTITY.test(text)) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name && HTML_WRITER_FNS.has(n.name.text)) return;
    const literal =
      ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !ts.isJsxAttribute(n.parent)) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n);
    if (literal) {
      const value = (n as ts.LiteralLikeNode).text;
      if (ENTITY.test(value)) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        hits.push(`${relative(SRC, file)}:${line} ${JSON.stringify(value.slice(0, 80))}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

describe("B17: no HTML entity inside a JS string", () => {
  it("every string literal in apps/web/src spells its punctuation as characters, since React prints a JS string as-is", () => {
    const hits = sourceFiles(SRC).flatMap(entityStrings);
    expect(hits).toEqual([]);
  });
});
