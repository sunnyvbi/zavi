
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type GoldenInput = {
  category: string;
  query: string;
  expected_note_ids: string[];
  notes?: string;
};

const VALID_CATEGORIES = new Set([
  "credit",
  "insurance",
  "dispute",
  "operator-policy",
  "other",
  "underwriting",
  "connectors",
  "prioritization",
  "routing",
  "positioning",
  "product-eng",
]);

function client(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svc) {
    console.error("missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  return createClient(url, svc, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function deactivateAll(sb: SupabaseClient, tenant_id: string): Promise<void> {
  const { error, count } = await sb
    .from("memory_recall_golden")
    .update({ active: false, updated_at: new Date().toISOString() }, { count: "exact" })
    .eq("tenant_id", tenant_id)
    .eq("active", true);
  if (error) {
    console.error("deactivate failed:", error.message);
    process.exit(1);
  }
  console.log(`deactivated ${count ?? 0} golden(s) for tenant ${tenant_id}`);
}

async function tenantOwnedActiveNotes(
  sb: SupabaseClient,
  tenant_id: string,
  note_ids: string[],
): Promise<Set<string>> {
  if (note_ids.length === 0) return new Set();
  const { data, error } = await sb
    .from("memory_note")
    .select("id")
    .eq("tenant_id", tenant_id)
    .is("superseded_by", null)
    .in("id", note_ids);
  if (error) {
    console.error("note validation query failed:", error.message);
    process.exit(1);
  }
  return new Set((data ?? []).map((r) => (r as { id: string }).id));
}

async function main(): Promise<void> {
  const tenant_id = process.argv[2];
  const arg2 = process.argv[3];
  const dryRun = process.argv.includes("--dry-run");
  if (!tenant_id) {
    console.error("usage: seed-recall-goldens.ts <tenant_id> <goldens.json> [--dry-run] | <tenant_id> --deactivate");
    process.exit(1);
  }

  const sb = client();

  if (arg2 === "--deactivate") {
    await deactivateAll(sb, tenant_id);
    return;
  }
  if (!arg2) {
    console.error("missing goldens.json path");
    process.exit(1);
  }

  const goldens = JSON.parse(readFileSync(arg2, "utf8")) as GoldenInput[];
  if (!Array.isArray(goldens) || goldens.length === 0) {
    console.error("goldens file must be a non-empty array");
    process.exit(1);
  }

  const { data: existingRows } = await sb
    .from("memory_recall_golden")
    .select("query")
    .eq("tenant_id", tenant_id)
    .eq("active", true);
  const existing = new Set((existingRows ?? []).map((r) => (r as { query: string }).query));

  let inserted = 0;
  let skipped = 0;
  let aborted = 0;

  for (const g of goldens) {
    if (!VALID_CATEGORIES.has(g.category)) {
      console.warn(`ABORT row (bad category "${g.category}"): ${g.query}`);
      aborted += 1;
      continue;
    }
    if (!g.query?.trim() || !Array.isArray(g.expected_note_ids) || g.expected_note_ids.length === 0) {
      console.warn(`ABORT row (empty query / no expected ids): ${JSON.stringify(g).slice(0, 120)}`);
      aborted += 1;
      continue;
    }
    if (existing.has(g.query)) {
      skipped += 1;
      continue;
    }

    const owned = await tenantOwnedActiveNotes(sb, tenant_id, g.expected_note_ids);
    const missing = g.expected_note_ids.filter((id) => !owned.has(id));
    if (missing.length > 0) {
      console.warn(`ABORT golden (expected note(s) missing/superseded/foreign: ${missing.join(",")}): "${g.query}"`);
      aborted += 1;
      continue;
    }

    if (dryRun) {
      console.log(`[dry-run] would insert: [${g.category}] "${g.query}" → ${g.expected_note_ids.length} note(s)`);
      inserted += 1;
      continue;
    }

    const { error } = await sb.from("memory_recall_golden").insert({
      tenant_id,
      category: g.category,
      query: g.query.trim(),
      expected_note_ids: g.expected_note_ids,
      notes: g.notes ?? null,
      active: true,
    });
    if (error) {
      console.warn(`insert failed for "${g.query}": ${error.message}`);
      aborted += 1;
      continue;
    }
    inserted += 1;
  }

  console.log(
    `${dryRun ? "[dry-run] " : ""}goldens: inserted=${inserted} skipped(existing)=${skipped} aborted=${aborted} tenant=${tenant_id}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
