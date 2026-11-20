#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";

const BACKEND = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SRC = join(BACKEND, "src");
const ALLOWLIST_FILE = join(BACKEND, ".tenant-scan-allowlist");
const WRAPPER = "src/services/tenant-client.ts";
const FACTORY = "src/services/supabase.ts";
const MIGRATIONS = join(BACKEND, "..", "..", "supabase", "migrations");

const args = process.argv.slice(2);
const baseRef = args.includes("--base") ? args[args.indexOf("--base") + 1] : null;
const strictRegistry = args.includes("--strict-registry");
const writeAllowlist = args.includes("--write-allowlist");

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

function importsServiceClient(code) {
  const stmts = code.match(/(?:import|export)\b[^;]*?\bfrom\s*["'][^"']*["']/g) || [];
  return stmts.some(
    (s) => /\bserviceClient\b/.test(s) && /supabase["']?\s*$|supabase["']/.test(s),
  );
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      out.push(...walk(p));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

function loadAllowlist() {
  const set = new Set();
  for (const line of readFileSync(ALLOWLIST_FILE, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    set.add(t);
  }
  return set;
}

const errors = [];
const warnings = [];

const importers = [];
for (const file of walk(SRC)) {
  const rel = relative(BACKEND, file);
  if (rel === WRAPPER || rel === FACTORY) continue;
  const code = stripComments(readFileSync(file, "utf8"));
  if (!importsServiceClient(code)) continue;
  importers.push(rel);
}
importers.sort();

if (writeAllowlist) {
  const { writeFileSync } = await import("node:fs");
  const header = [
    "# tenant-isolation scan allowlist — shrink-only.",
    "# Files here still import the raw service-role serviceClient() (pre-tenantClient).",
    "# The CI scan (scripts/scan-tenant-isolation.mjs) FAILS if a file NOT listed here",
    "# imports serviceClient, if this list GROWS, or if a listed file ADDS an import in a PR diff.",
    "# Migrate a file onto tenantClient(), then delete its line here. This list may only shrink.",
    "# Regenerate the seed with: node scripts/scan-tenant-isolation.mjs --write-allowlist",
    "#",
  ];
  writeFileSync(ALLOWLIST_FILE, header.concat(importers).join("\n") + "\n");
  console.log(`wrote .tenant-scan-allowlist with ${importers.length} entries (scanner-detected).`);
  process.exit(0);
}

const allow = loadAllowlist();

const strictBannedImport = !baseRef;

const offenders = importers.filter((rel) => !allow.has(rel));
for (const o of offenders) {
  const msg = `[banned-import] ${o} imports the raw serviceClient — route it through tenantClient(tid) (services/tenant-client.ts), or (if a reviewed escape) add it to .tenant-scan-allowlist.`;
  if (strictBannedImport) {
    errors.push(msg);
  } else {
    warnings.push(`${msg} (pre-existing service-role importer — new imports are still blocked by the [added-import] check; migrate or allowlist in a dedicated PR)`);
  }
}
const importerSet = new Set(importers);
for (const entry of allow) {
  if (!importerSet.has(entry)) {
    errors.push(`[stale-allowlist] ${entry} is allowlisted but no longer imports serviceClient — delete its line (allowlist is shrink-only).`);
  }
}

if (baseRef) {
  let diff = "";
  try {
    diff = execFileSync(
      "git",
      ["diff", `${baseRef}...HEAD`, "--", "apps/backend/src"],
      { cwd: join(BACKEND, "..", ".."), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (e) {
    warnings.push(`[diff] could not compute diff vs ${baseRef}: ${e.message}`);
  }
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const added = line.slice(1);
    if (/\bserviceClient\b/.test(added) && /(import|export)\b/.test(added) && /supabase/.test(added)) {
      errors.push(`[added-import] a PR line ADDS a serviceClient import — not allowed even in an allowlisted file:  ${added.trim()}`);
    }
  }
}

try {
  const wrapperSrc = readFileSync(join(BACKEND, WRAPPER), "utf8");
  const regBlock = wrapperSrc.slice(wrapperSrc.indexOf("const REGISTRY"));
  const classified = new Set([...regBlock.matchAll(/^\s*([a-z_][a-z0-9_]*)\s*:/gim)].map((m) => m[1]));
  const tables = new Set();
  for (const f of readdirSync(MIGRATIONS)) {
    if (!f.endsWith(".sql")) continue;
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?["`]?([a-z_][a-z0-9_]*)["`]?/gi)) {
      tables.add(m[1]);
    }
  }
  const unclassified = [...tables].filter((t) => !classified.has(t)).sort();
  if (unclassified.length) {
    const msg = `[registry] ${unclassified.length} public table(s) not classified in tenant-client.ts REGISTRY (facade will fail-closed on them): ${unclassified.slice(0, 12).join(", ")}${unclassified.length > 12 ? " …" : ""}`;
    if (strictRegistry) errors.push(msg);
    else warnings.push(msg);
  }
} catch (e) {
  warnings.push(`[registry] completeness check skipped: ${e.message}`);
}

const SCOPED_READ_HELPERS = ["getAgentRunById"];
const SCOPED_READ_DIRS = [SRC, join(BACKEND, "scripts")];
for (const file of SCOPED_READ_DIRS.flatMap((d) => walk(d))) {
  const rel = relative(BACKEND, file);
  const code = stripComments(readFileSync(file, "utf8"));
  for (const helper of SCOPED_READ_HELPERS) {
    const callRe = new RegExp(`(?<![.\\w])${helper}\\(([^,)\\n]*)\\)`, "g");
    for (const m of code.matchAll(callRe)) {
      if (new RegExp(`function\\s+${helper}`).test(code.slice(Math.max(0, m.index - 40), m.index))) continue;
      errors.push(`[unscoped-read] ${rel}: ${helper}(${m[1].trim()}) called with a single arg — it now requires a TenantId as the first arg: ${helper}(tid, ${m[1].trim()}). Mint the TenantId at a trust boundary.`);
    }
  }
}

console.log(`tenant-isolation scan: ${importers.length} serviceClient importers, ${allow.size} allowlisted, ${offenders.length} offenders.`);
for (const w of warnings) console.log(`WARN  ${w}`);
if (errors.length) {
  console.error(`\nFAIL — ${errors.length} isolation violation(s):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log("OK — no new service-role isolation violations.");
