
import { createClient } from "@supabase/supabase-js";
import { Client as PgClient } from "pg";

const DRY_RUN = process.argv.includes("--dry-run");

type Row = {
  id: string;
  tenant_id: string;
  content_hash: string;
  tags: string[] | null;
  updated_at: string;
};

const UNIQUE_INDEX_SQL =
  "create unique index concurrently if not exists memory_note_content_hash_uniq " +
  "on memory_note (tenant_id, content_hash) where slug is null and superseded_by is null;";

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Run with `node --env-file=.env ...`");
    process.exit(2);
  }
  const sb = createClient(url, key);

  const rows: Row[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("memory_note")
      .select("id, tenant_id, content_hash, tags, updated_at")
      .is("slug", null)
      .is("superseded_by", null)
      .not("content_hash", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error(`[dedup] scan failed: ${error.message}`);
      process.exit(1);
    }
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.tenant_id}::${r.content_hash}`;
    const arr = groups.get(k) ?? [];
    arr.push(r);
    groups.set(k, arr);
  }
  const dupGroups = [...groups.values()].filter((g) => g.length > 1);

  let loserCount = 0;
  const loserIds: string[] = [];
  for (const g of dupGroups) {
    g.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    for (const loser of g.slice(1)) {
      loserCount += 1;
      loserIds.push(loser.id);
    }
  }

  let takesAffected = 0;
  if (loserIds.length > 0) {
    const { count } = await sb
      .from("takes")
      .select("id", { count: "exact", head: true })
      .in("source_note_id", loserIds.slice(0, 1000));
    takesAffected = count ?? 0;
  }

  console.log(
    `[dedup] ${dupGroups.length} dup group(s), ${loserCount} loser row(s), ` +
      `${takesAffected}+ takes reference a loser (provenance PRESERVED via superseded_by).`,
  );

  if (DRY_RUN) {
    console.log("[dedup] DRY RUN — no writes. Re-run without --dry-run to collapse + build the unique index.");
    return;
  }

  let superseded = 0;
  for (const g of dupGroups) {
    g.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    const winner = g[0];
    const losers = g.slice(1);
    const mergedTags = Array.from(new Set(g.flatMap((r) => r.tags ?? [])));
    await sb
      .from("memory_note")
      .update({ tags: mergedTags, updated_at: new Date().toISOString() })
      .eq("id", winner.id);
    for (const loser of losers) {
      const { error } = await sb
        .from("memory_note")
        .update({ superseded_by: winner.id })
        .eq("id", loser.id)
        .eq("tenant_id", loser.tenant_id);
      if (error) {
        console.error(`[dedup] supersede ${loser.id} -> ${winner.id} failed: ${error.message}`);
      } else {
        superseded += 1;
      }
    }
  }
  console.log(`[dedup] superseded ${superseded} loser row(s) into winners.`);

  let residual = 0;
  for (const g of dupGroups) {
    const { tenant_id, content_hash } = g[0];
    const { count } = await sb
      .from("memory_note")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant_id)
      .eq("content_hash", content_hash)
      .is("slug", null)
      .is("superseded_by", null);
    if ((count ?? 0) > 1) residual += 1;
  }
  if (residual > 0) {
    console.error(
      `[dedup] ${residual} group(s) still have >1 live row after collapse — NOT creating the unique index. ` +
        `Fix the supersede errors above and re-run.`,
    );
    process.exit(1);
  }

  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log(
      "[dedup] No SUPABASE_DB_URL/DATABASE_URL — cannot run DDL from this script.\n" +
        "[dedup] Run this in the Supabase SQL editor / psql to enforce dedup going forward:\n\n" +
        `  ${UNIQUE_INDEX_SQL}\n`,
    );
    return;
  }
  const pg = new PgClient({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  try {
    await pg.query(UNIQUE_INDEX_SQL);
    console.log("[dedup] partial UNIQUE index created (memory_note_content_hash_uniq).");
  } finally {
    await pg.end();
  }
}

main().catch((e) => {
  console.error("[dedup] fatal:", e);
  process.exit(1);
});
