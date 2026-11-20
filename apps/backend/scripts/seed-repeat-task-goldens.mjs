
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const byFlag = argv.find((a) => a.startsWith("--by="));
const createdByDefault = byFlag ? byFlag.split("=").slice(1).join("=") : "seed-script";
const positional = argv.filter((a) => !a.startsWith("--"));
const tenantId = positional[0];
const jsonPath = positional[1];

if (!tenantId || !jsonPath) {
  fail("usage: seed-repeat-task-goldens.mjs <tenant_id> <goldens.json> [--by=name]");
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  fail("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (run with --env-file=.env)");
}

let raw;
try {
  raw = JSON.parse(readFileSync(jsonPath, "utf-8"));
} catch (e) {
  fail(`could not read/parse ${jsonPath}: ${e.message}`);
}
if (!Array.isArray(raw)) fail("goldens JSON must be an ARRAY of golden objects");
if (raw.length === 0) fail("goldens JSON array is empty");

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

const rows = raw.map((g, i) => {
  if (!g || typeof g !== "object") fail(`row ${i}: not an object`);
  if (!isNonEmptyString(g.agent_slug)) fail(`row ${i}: missing human 'agent_slug'`);
  if (!isNonEmptyString(g.query)) fail(`row ${i}: missing human 'query'`);
  if (!isNonEmptyString(g.ideal_answer))
    fail(`row ${i}: missing human 'ideal_answer' (labels are human — not fabricated)`);
  if (g.rubric != null && typeof g.rubric !== "object")
    fail(`row ${i}: 'rubric' must be an object if present`);
  return {
    tenant_id: tenantId,
    agent_slug: g.agent_slug.trim(),
    query: g.query,
    ideal_answer: g.ideal_answer,
    rubric: g.rubric ?? {},
    active: typeof g.active === "boolean" ? g.active : true,
    created_by: isNonEmptyString(g.created_by) ? g.created_by : createdByDefault,
  };
});

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data, error } = await sb
  .from("repeat_task_golden")
  .insert(rows)
  .select("id, agent_slug, active");
if (error) fail(`insert failed: ${error.message}`);

console.log(`Seeded ${data.length} golden(s) for tenant ${tenantId}:`);
for (const r of data) {
  console.log(`  • ${r.agent_slug}  ${r.id}  active=${r.active}`);
}
