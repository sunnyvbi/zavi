#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { digestSchema } from "../src/agents/chief-of-staff/output-schema";

const ENVELOPE_RE = /<digest>([\s\S]*?)<\/digest>/;

const SYNTHETIC_FIXTURE = `Some preamble the LLM may or may not emit (we strip it).
<digest>
{
  "tier1": [
    {
      "title": "Bootstrap fleet — no agent activity to synthesize yet.",
      "summary": "First run; nothing else has reported in.",
      "evidence": ["run-id N/A — agents.scanRecentRuns returned []"]
    }
  ],
  "tier2": [],
  "tier3": [],
  "tier4": [],
  "rendered_markdown": "# Daily digest\\n\\n## Tier 1 — Decide today\\n- Bootstrap fleet — no agent activity to synthesize yet.\\n"
}
</digest>
trailing chatter that should be ignored too.`;

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? `   (${detail})` : ""}`);
  }
}

function runFixture(label: string, raw: string): void {
  const m = raw.match(ENVELOPE_RE);
  if (!m) {
    fail++;
    console.log(`  ✗ ${label}: no <digest> block found`);
    return;
  }
  let inner: unknown;
  try {
    inner = JSON.parse(m[1]);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${label}: JSON.parse failed — ${(e as Error).message}`);
    return;
  }
  const result = digestSchema.safeParse(inner);
  if (!result.success) {
    fail++;
    console.log(`  ✗ ${label}: schema fail — ${result.error.message.slice(0, 200)}`);
    return;
  }
  const parsed = result.data;
  assert(`${label}: rendered_markdown non-empty`, parsed.rendered_markdown.length > 0);
  assert(`${label}: tier1 array shape`, Array.isArray(parsed.tier1));
  if (parsed.tier1.length > 0) {
    assert(
      `${label}: every tier1 entry has evidence non-empty`,
      parsed.tier1.every((t) => t.evidence.length > 0),
    );
  }
}

console.log("[cos-replay smoke]");
runFixture("synthetic-baseline", SYNTHETIC_FIXTURE);

const fixturesDir = path.join(process.cwd(), "test-fixtures");
if (fs.existsSync(fixturesDir)) {
  const files = fs.readdirSync(fixturesDir).filter((f) => f.startsWith("cos-raw-") && f.endsWith(".txt"));
  if (files.length === 0) {
    console.log("  (no cos-raw-*.txt fixtures in test-fixtures/; skipping captured-fixture replay)");
  }
  for (const f of files) {
    const raw = fs.readFileSync(path.join(fixturesDir, f), "utf-8");
    runFixture(f, raw);
  }
} else {
  console.log("  (test-fixtures/ does not exist; run scripts/capture-cos-raw.ts to populate)");
}

console.log("");
console.log(`  ${pass} passed · ${fail} failed`);
if (fail > 0) process.exit(1);
