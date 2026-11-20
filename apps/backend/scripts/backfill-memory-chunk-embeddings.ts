
import { createClient } from "@supabase/supabase-js";
import { embedTexts } from "@/services/memory/embed";

const BATCH = 64;

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}
const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT_ARG = arg("--limit");
const LIMIT = LIMIT_ARG ? Number(LIMIT_ARG) : Infinity;

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Run with `node --env-file=.env ...`");
    process.exit(2);
  }
  const sb = createClient(url, key);

  const { count: nullCount } = await sb
    .from("memory_chunk")
    .select("*", { count: "exact", head: true })
    .is("embedding", null);
  console.log(`[backfill] null_embedding chunks in DB: ${nullCount ?? "?"}`);
  if (!nullCount) {
    console.log("[backfill] nothing to do.");
    return;
  }
  if (DRY_RUN) {
    console.log("[backfill] DRY RUN — exiting before any embed / write.");
    return;
  }

  let processed = 0;
  let updated = 0;
  let failed = 0;

  while (processed < LIMIT) {
    const remaining = Math.min(BATCH, LIMIT - processed);
    const { data, error } = await sb
      .from("memory_chunk")
      .select("id, tenant_id, body")
      .is("embedding", null)
      .order("created_at", { ascending: true })
      .limit(remaining);
    if (error) {
      console.error(`[backfill] scan failed: ${error.message}`);
      process.exit(1);
    }
    const rows = (data ?? []) as Array<{ id: string; tenant_id: string; body: string }>;
    if (rows.length === 0) break;

    let vectors: number[][];
    try {
      vectors = await embedTexts(
        rows.map((r) => r.body),
        "document",
      );
    } catch (e) {
      console.error(`[backfill] embed batch failed:`, e);
      process.exit(1);
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const v = vectors[i];
      if (!v) {
        failed += 1;
        continue;
      }
      const { error: upErr } = await sb
        .from("memory_chunk")
        .update({ embedding: v })
        .eq("id", row.id)
        .eq("tenant_id", row.tenant_id);
      if (upErr) {
        console.warn(`[backfill] update failed for chunk ${row.id}: ${upErr.message}`);
        failed += 1;
        continue;
      }
      updated += 1;
    }
    processed += rows.length;
    console.log(`[backfill] processed=${processed} updated=${updated} failed=${failed}`);
  }

  console.log(`[backfill] DONE. processed=${processed} updated=${updated} failed=${failed}`);
}

main().catch((e) => {
  console.error("[backfill] uncaught:", e);
  process.exit(1);
});
