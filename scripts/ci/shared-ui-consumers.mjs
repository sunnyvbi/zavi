#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHARED_MIN = 3;
const WEB_SRC = "apps/web/src";
const APP_DIR = `${WEB_SRC}/app`;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function changedFiles(range) {
  const out = execFileSync("git", ["diff", "--name-only", range], { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

function sourceFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules" && name !== "__tests__") files.push(...sourceFiles(p));
    } else if (/\.(tsx?|jsx?)$/.test(name) && !/\.(test|spec)\./.test(name)) files.push(p);
  }
  return files;
}

const EXTS = ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts"];

function resolveImport(fromFile, spec) {
  let base;
  if (spec.startsWith("@/")) base = join(WEB_SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = join(dirname(fromFile), spec);
  else return null;
  for (const ext of EXTS) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

export function reverseImports(files, readFile) {
  const rev = new Map();
  const IMPORT = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const f of files) {
    for (const m of readFile(f).matchAll(IMPORT)) {
      const target = resolveImport(f, m[1] ?? m[2]);
      if (!target) continue;
      if (!rev.has(target)) rev.set(target, new Set());
      rev.get(target).add(f);
    }
  }
  return rev;
}

function reachedEntries(file, rev) {
  const seen = new Set([file]);
  const queue = [file];
  const entries = new Set();
  while (queue.length) {
    const cur = queue.shift();
    for (const imp of rev.get(cur) ?? []) {
      if (seen.has(imp)) continue;
      seen.add(imp);
      if (imp.startsWith(`${APP_DIR}/`) && /\/(page|layout)\.tsx?$/.test(imp)) entries.add(imp);
      queue.push(imp);
    }
  }
  return [...entries];
}

function routeOf(file) {
  const rel = relative(APP_DIR, file).replace(/\/?(page|layout)\.tsx?$/, "");
  const kind = /layout\.tsx?$/.test(file) ? " (layout)" : "";
  return (rel ? `/${rel}` : "/") + kind;
}

export function sharedUiReport(changed, rev) {
  const lines = [];
  if (changed.includes(`${APP_DIR}/layout.tsx`)) {
    lines.push("- `apps/web/src/app/layout.tsx` (root layout): **every page**");
  }
  const candidates = changed.filter(
    (f) =>
      f.startsWith(`${WEB_SRC}/`) &&
      !f.startsWith(`${APP_DIR}/`) &&
      /\.(tsx?|jsx?)$/.test(f) &&
      !/\.(test|spec)\./.test(f) &&
      !f.includes("__tests__"),
  );
  for (const file of candidates) {
    const reached = reachedEntries(file, rev);
    const viaLayout = reached.some((e) => /\/layout\.tsx?$/.test(e));
    if (reached.length >= SHARED_MIN || viaLayout) {
      const routes = reached.map(routeOf).sort();
      const note = viaLayout ? " (includes a layout, so every page under it)" : "";
      lines.push(`- \`${file}\` renders on ${reached.length} pages${note}: ${routes.map((r) => `\`${r}\``).join(", ")}`);
    }
  }
  if (lines.length === 0) return "";
  return [
    "### Shared web UI changed",
    "This PR changes a component that renders on several pages. Check that each of these still looks right, not only the page the PR is about:",
    "",
    ...lines,
    "",
  ].join("\n");
}

function isMain() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1] ?? ""));
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    const range = arg("--range") ?? "HEAD^1..HEAD";
    const rev = reverseImports(sourceFiles(WEB_SRC), (f) => readFileSync(f, "utf8"));
    const report = sharedUiReport(changedFiles(range), rev);
    if (report) {
      console.log(report);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
    } else {
      console.log("No shared web UI component changed.");
    }
  } catch (e) {
    console.log(`shared-ui-consumers: skipped (${e instanceof Error ? e.message : String(e)})`);
  }
}
