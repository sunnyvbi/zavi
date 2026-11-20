import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const tIdx = process.argv.indexOf("--tenant");
const ONLY_TENANT = tIdx > -1 ? process.argv[tIdx + 1] : null;

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const REJECTED_ONLY = "rejected";

let q = sb
  .from("decisions")
  .select("id, tenant_id, decision_class, body, status, emitted_at")
  .eq("status", REJECTED_ONLY)
  .order("emitted_at", { ascending: true });
if (ONLY_TENANT) q = q.eq("tenant_id", ONLY_TENANT);

const { data: rows, error } = await q;
if (error) {
  console.error("read failed:", error.message);
  process.exit(1);
}

console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${rows.length} rejected decision(s) considered`);
if (ONLY_TENANT) console.log(`tenant filter: ${ONLY_TENANT}`);
console.log("");

const byClass = {};
for (const r of rows) {
  byClass[r.decision_class] = (byClass[r.decision_class] || 0) + 1;
}
console.log("rejected rows by class:");
for (const [cls, n] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(n).padStart(4)}  ${cls}`);
}
console.log("");

let wrote = 0, skipped = 0, failed = 0;
const seen = new Set();

for (const r of rows) {
  if (!APPLY) {
    const key = `${r.tenant_id}|${r.decision_class}`;
    if (!seen.has(key)) {
      seen.add(key);
      console.log(`WOULD SEED  tenant=${r.tenant_id.slice(0, 8)}  class=${r.decision_class}`);
    }
    wrote++;
    continue;
  }
  const { data, error: e } = await sb.rpc("suppress_decision", {
    p_decision_id: r.id,
    p_source: "backfill",
  });
  if (e) {
    console.warn(`FAILED  ${r.id}: ${e.message}`);
    failed++;
  } else if (data === null) {
    skipped++;
  } else {
    wrote++;
  }
}

console.log("");
console.log(`${APPLY ? "wrote" : "would write"}: ${wrote}   skipped (no derivable key): ${skipped}   failed: ${failed}`);
if (!APPLY) {
  console.log("");
  console.log("DRY RUN — nothing written. Re-run with --apply once the above looks right.");
}
