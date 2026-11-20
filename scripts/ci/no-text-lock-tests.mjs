#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TEST_FILE = /\.test\.(ts|tsx|mts|mjs|js|jsx)$/;

const IMPORT =
  /(?:\bfrom\s+|\bimport\s+(?=["'])|\bimport\s*\(\s*|\brequire\s*\(\s*|\bvi\.(?:mock|doMock|importActual|importMock)\s*(?:<[^>]*>)?\(\s*)["']([^"']+)["']/g;

const TYPE_ONLY_IMPORT =
  /\bimport\s+type\s+[^;]*?\bfrom\s+["'][^"']+["'];?|\bimport\s*\{\s*(?:type\s+[\w$]+(?:\s+as\s+[\w$]+)?\s*,?\s*)+\}\s*from\s+["'][^"']+["'];?/g;

const NODE_BUILTIN =
  /^(?:node:)?(?:fs|path|url|os|child_process|crypto|util|assert|module)(?:\/.*)?$/;

const HARNESS = new Set(["vitest", "yaml", "js-yaml", "glob", "fast-glob", "gray-matter", "typescript"]);

const DATA_FILE = /\.(?:json|md|sql|ya?ml|txt|csv)$/;

const READS_FILES = /\b(?:readFileSync|readFile|readdirSync|readdir|globSync)\b/;

const ALLOW = /\/\/[ \t]*text-lock-ok:[ \t]*\S/;

export function isTextLockTest(content) {
  if (!READS_FILES.test(content)) return false;
  const runtime = content.replace(TYPE_ONLY_IMPORT, "");
  for (const m of runtime.matchAll(IMPORT)) {
    const spec = m[1];
    if (NODE_BUILTIN.test(spec) || HARNESS.has(spec)) continue;
    const local = spec.startsWith(".") || spec.startsWith("@/") || spec.startsWith("~/") || spec.startsWith("@zavi/");
    if (local && DATA_FILE.test(spec)) continue;
    return false;
  }
  return true;
}

export function isAllowed(content) {
  return ALLOW.test(content.split("\n").slice(0, 15).join("\n"));
}

function addedTestFiles(range) {
  const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=A", range], { encoding: "utf8" });
  return out.split("\n").filter((f) => TEST_FILE.test(f));
}

export function check(paths, read = (p) => readFileSync(p, "utf8")) {
  const offenders = [];
  for (const p of paths) {
    let content;
    try {
      content = read(p);
    } catch {
      continue;
    }
    if (isTextLockTest(content) && !isAllowed(content)) offenders.push(p);
  }
  return offenders;
}

function main(argv) {
  const i = argv.indexOf("--range");
  if (i < 0 || !argv[i + 1]) {
    console.error("usage: no-text-lock-tests.mjs --range <base>..<head>");
    return 2;
  }
  const offenders = check(addedTestFiles(argv[i + 1]));
  if (offenders.length === 0) {
    console.log("no new text-lock tests");
    return 0;
  }
  console.error("New text-lock tests (import no product code, assert on file text):");
  for (const p of offenders) console.error(`  ${p}`);
  console.error(
    "\nA test like this cannot fail when behaviour breaks, only when the file is reworded." +
      "\nImport the code and assert what it does. If this really must guard a file's text" +
      "\n(a deploy workflow invariant, config drift), add within the first 15 lines:" +
      "\n  // text-lock-ok: <why a behaviour test cannot cover this>",
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2)));
}
