#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";

const BACKEND = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ROUTES = join(BACKEND, "src", "routes");
const ALLOWLIST_FILE = join(BACKEND, ".route-auth-allowlist");

const args = process.argv.slice(2);
const baseRef = args.includes("--base") ? args[args.indexOf("--base") + 1] : null;
const writeAllowlist = args.includes("--write-allowlist");

const AUTH_TOKENS = /\b(requireAuth|authMiddleware|requireStaff|staffMiddleware|assertStaff|gateRaise|verifyBearer|requireCreator|adsAuth|requireConnectorToken|resolveShopifyAppContext)\b/;

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
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
  let text = "";
  try {
    text = readFileSync(ALLOWLIST_FILE, "utf8");
  } catch {
    return set;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#")) set.add(t);
  }
  return set;
}

const unauthed = [];
for (const file of walk(ROUTES)) {
  const rel = relative(BACKEND, file);
  const code = stripComments(readFileSync(file, "utf8"));
  if (!AUTH_TOKENS.test(code)) unauthed.push(rel);
}
unauthed.sort();

if (writeAllowlist) {
  const header = [
    "# route-auth guardrail allowlist (GAP 21) — shrink-only.",
    "# Files here are route files that reference NO in-file auth token — i.e.",
    "# genuinely-public routes (webhooks / health / oauth / inngest) OR routes",
    "# auth'd by a router-level mount (e.g. /api/admin via requireStaff in app.ts).",
    "# CI FAILS if a route file NOT listed here references no auth token (a new",
    "# endpoint that forgot auth). Wire auth in the file, then it drops off this",
    "# list. This list may only SHRINK. Reseed: node scripts/scan-route-auth.mjs --write-allowlist",
    "#",
  ];
  writeFileSync(ALLOWLIST_FILE, header.concat(unauthed).join("\n") + "\n");
  console.log(`wrote .route-auth-allowlist with ${unauthed.length} entries.`);
  process.exit(0);
}

const allow = loadAllowlist();
const errors = [];

for (const rel of unauthed) {
  if (!allow.has(rel)) {
    errors.push(
      `[unauthed-route] ${rel} — a route file with no auth token (requireAuth / authMiddleware / requireStaff / staffMiddleware / assertStaff / gateRaise / verifyBearer). Wire auth in the handler, mount it under an auth'd router, or (if genuinely public: webhook/health/oauth) add it to .route-auth-allowlist with a one-line reason.`,
    );
  }
}
const unauthedSet = new Set(unauthed);
for (const entry of allow) {
  if (!unauthedSet.has(entry)) {
    errors.push(`[stale-allowlist] ${entry} now has an auth token (or was deleted) — remove its line (allowlist is shrink-only).`);
  }
}

if (baseRef) {
  try {
    const added = execFileSync("git", ["diff", "--name-only", "--diff-filter=A", `${baseRef}...HEAD`, "--", "apps/backend/src/routes"], {
      cwd: join(BACKEND, "..", ".."),
      encoding: "utf8",
    })
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.endsWith(".ts") && !l.endsWith(".test.ts"));
    for (const f of added) {
      const rel = f.replace(/^apps\/backend\//, "");
      if (unauthedSet.has(rel) && !allow.has(rel)) {
        errors.push(`[added-unauthed-route] PR adds ${rel} with no auth token — wire auth before merge.`);
      }
    }
  } catch (e) {
    console.log(`WARN [diff] could not compute added routes vs ${baseRef}: ${e.message}`);
  }
}

console.log(`route-auth scan: ${unauthed.length} route files with no auth token, ${allow.size} allowlisted.`);
if (errors.length) {
  console.error(`\nFAIL — ${errors.length} route-auth violation(s):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log("OK — no new un-authed routes.");
