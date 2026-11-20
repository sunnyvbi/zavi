#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "supabase", "migrations",
);

const ALLOWLIST = new Map([
  ["packs", "Pack registry: non-secret catalog, explicitly global by design (0014_pack_registry.sql)."],
  ["decision_classes", "Global autonomy config: class slugs + defaults, no tenant or personal data."],
  ["autopilot_fleet_kill", "A single global boolean halt row."],
  ["inbox_domain", "Shared mail-domain registry. Its sibling inbox_handle_ledger IS tenant-gated."],
]);

const policyRe = /create\s+policy\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?\s+on\s+(?:public\.)?"?([a-z0-9_]+)"?([\s\S]*?);/gi;
const dropRe = /drop\s+policy\s+(?:if\s+exists\s+)?"?([a-z0-9_]+)"?\s+on\s+(?:public\.)?"?([a-z0-9_]+)"?/gi;

const live = new Map();

for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
  const sql = readFileSync(join(MIGRATIONS, file), "utf8");
  const stripped = sql.replace(/^\s*--.*$/gm, "");

  const events = [];
  for (const m of stripped.matchAll(policyRe)) {
    const [full, policy, table, body] = m;
    const b = body.toLowerCase();
    const permissive =
      /\bto\s+authenticated\b/.test(b) &&
      /using\s*\(\s*true\s*\)/.test(b) &&
      !/\bas\s+restrictive\b/.test(b);
    events.push({ at: m.index, kind: "create", policy, table, permissive });
  }
  for (const m of stripped.matchAll(dropRe)) {
    events.push({ at: m.index, kind: "drop", policy: m[1], table: m[2] });
  }
  events.sort((a, b) => a.at - b.at);

  for (const e of events) {
    const key = `${e.table}.${e.policy}`;
    if (e.kind === "drop") { live.delete(key); continue; }
    if (e.permissive && !ALLOWLIST.has(e.table)) {
      live.set(key, { file, policy: e.policy, table: e.table });
    } else {
      live.delete(key);
    }
  }
}

const violations = [...live.values()];

if (violations.length) {
  console.error("\n✗ Permissive RLS policy found — `to authenticated using (true)` on a non-allowlisted table:\n");
  for (const v of violations) {
    console.error(`  ${v.file}\n    policy ${v.policy} on ${v.table}`);
  }
  console.error(
    "\nEvery signed-in user of EVERY tenant can read that table — including bench\n" +
    "members, who are auth.users with no tenant membership.\n\n" +
    "Fix it, or if the data is genuinely non-secret global catalog data, add the\n" +
    "table to ALLOWLIST in this script WITH a justification.\n",
  );
  process.exit(1);
}

console.log(`✓ No non-allowlisted permissive RLS policies. (${ALLOWLIST.size} allowlisted globals.)`);
