
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { grammarForFile, parseFile } from "./parse-ts";
import type { ExtractResult, RefRow, SymbolRow } from "./types";

const SKIP_DIRS = new Set<string>([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
  "vendor",
]);

const MAX_FILE_BYTES = 1_000_000;

export const REF_CAP_PER_SYMBOL = 50;

async function collectSourceFiles(dir: string, acc: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collectSourceFiles(full, acc);
    } else if (entry.isFile()) {
      if (grammarForFile(entry.name)) acc.push(full);
    }
  }
}

export async function extractSymbols(repoDir: string): Promise<ExtractResult> {
  const files: string[] = [];
  await collectSourceFiles(repoDir, files);

  const symbols: SymbolRow[] = [];
  const refs: RefRow[] = [];

  for (const absPath of files) {
    try {
      const stat = await fs.stat(absPath);
      if (stat.size > MAX_FILE_BYTES) {
        continue;
      }
      const source = await fs.readFile(absPath, "utf8");
      const relPath = path.relative(repoDir, absPath).split(path.sep).join("/");
      const parsed = await parseFile(relPath, source);
      symbols.push(...parsed.symbols);
      refs.push(...parsed.refs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[code-index] skipped ${absPath}: ${msg}`);
      continue;
    }
  }

  return { symbols, refs: capReferenceRefs(refs) };
}

export function capReferenceRefs(refs: RefRow[]): RefRow[] {
  const perSymbolRefCount = new Map<string, number>();
  const out: RefRow[] = [];
  for (const ref of refs) {
    if (ref.ref_kind !== "reference") {
      out.push(ref);
      continue;
    }
    const seen = perSymbolRefCount.get(ref.symbol_name) ?? 0;
    if (seen >= REF_CAP_PER_SYMBOL) continue;
    perSymbolRefCount.set(ref.symbol_name, seen + 1);
    out.push(ref);
  }
  return out;
}
