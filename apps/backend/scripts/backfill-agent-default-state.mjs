#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const ALWAYS_ON = new Set([
  "operator",
  "pm",
  "performance-marketer",
  "engineer",
  "qa",
]);

const ENABLED = new Set([
  "chief-of-staff",
  "dispute-response",
  "growth-lead",
  "support-lead",
  "research",
]);

const DISABLED = new Set([
  "advisor",
]);

function stateFor(slug) {
  if (ALWAYS_ON.has(slug)) return "always_on";
  if (ENABLED.has(slug)) return "enabled";
  if (DISABLED.has(slug)) return "disabled";
  return null;
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const AGENTS_ROOT = path.join(REPO_ROOT, "apps/backend/src/agents");

const slugs = fs
  .readdirSync(AGENTS_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_") && d.name !== "lib")
  .map((d) => d.name)
  .filter((s) => fs.existsSync(path.join(AGENTS_ROOT, s, "agent.md")));

console.log(`Found ${slugs.length} agents`);

const unknown = slugs.filter((s) => stateFor(s) === null);
if (unknown.length > 0) {
  console.error(`ERROR: unknown agents not categorized: ${unknown.join(", ")}`);
  console.error("Update the ALWAYS_ON / ENABLED / DISABLED sets in this script.");
  process.exit(1);
}

const counts = { always_on: 0, enabled: 0, disabled: 0, already: 0 };

for (const slug of slugs) {
  const file = path.join(AGENTS_ROOT, slug, "agent.md");
  const raw = fs.readFileSync(file, "utf-8");

  if (/^\s*visibility:\s*$/m.test(raw) && /^\s+default_state:/m.test(raw)) {
    counts.already++;
    continue;
  }

  const state = stateFor(slug);
  const insertion = `    visibility:\n      default_state: ${state}\n`;

  const lines = raw.split("\n");
  let fmOpen = -1;
  let fmClose = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "---") {
      if (fmOpen === -1) fmOpen = i;
      else if (fmClose === -1) { fmClose = i; break; }
    }
  }
  if (fmOpen === -1 || fmClose === -1) {
    console.error(`${slug}: no frontmatter, skipping`);
    continue;
  }

  let metaIdx = -1;
  let praxisIdx = -1;
  for (let i = fmOpen + 1; i < fmClose; i++) {
    if (/^metadata:\s*$/.test(lines[i])) metaIdx = i;
    if (metaIdx !== -1 && /^\s{2}praxis:\s*$/.test(lines[i])) {
      praxisIdx = i;
      break;
    }
  }
  if (praxisIdx === -1) {
    console.error(`${slug}: no metadata.praxis block, skipping`);
    continue;
  }

  let praxisEnd = fmClose;
  for (let i = praxisIdx + 1; i < fmClose; i++) {
    if (lines[i] === "") continue;
    if (!/^ {4,}/.test(lines[i])) {
      praxisEnd = i;
      break;
    }
  }

  const newLines = [
    ...lines.slice(0, praxisEnd),
    ...insertion.split("\n").slice(0, -1),
    ...lines.slice(praxisEnd),
  ];

  fs.writeFileSync(file, newLines.join("\n"));
  counts[state]++;
  console.log(`  ${slug}: default_state=${state}`);
}

console.log(
  `\nDone. always_on=${counts.always_on} enabled=${counts.enabled} disabled=${counts.disabled} already=${counts.already}`,
);

const expected = { always_on: 5, enabled: 11, disabled: 16 };
const total = counts.always_on + counts.enabled + counts.disabled + counts.already;
if (total !== 32) {
  console.error(`ERROR: total ${total} != 32 expected`);
  process.exit(1);
}
console.log(`✓ 32 agents categorized (already counted toward expected ${expected.always_on}/${expected.enabled}/${expected.disabled})`);
