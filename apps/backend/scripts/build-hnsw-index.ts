
import { Client as PgClient } from "pg";

const DRY_RUN = process.argv.includes("--dry-run");

const HNSW_SQL =
  "create index concurrently if not exists memory_chunk_embedding_hnsw " +
  "on memory_chunk using hnsw (embedding vector_cosine_ops) " +
  "where embedding is not null;";

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error(
      "SUPABASE_DB_URL or DATABASE_URL must be set (supabase-js can't run DDL).\n" +
        "To run by hand in the Supabase SQL editor / psql:\n\n  " +
        HNSW_SQL +
        "\n",
    );
    process.exit(2);
  }
  const pg = new PgClient({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  try {
    const { rows: am } = await pg.query("select 1 from pg_am where amname = 'hnsw'");
    if (am.length === 0) {
      console.error(
        "[hnsw] this Postgres has no 'hnsw' access method — pgvector is too old (need >= 0.5.0). Aborting.",
      );
      process.exit(1);
    }
    const { rows: cnt } = await pg.query(
      "select count(*)::int as n from memory_chunk where embedding is not null",
    );
    console.log(`[hnsw] pgvector hnsw available; ${cnt[0]?.n ?? "?"} non-null-embedding chunk(s) to index.`);
    if (DRY_RUN) {
      console.log(`[hnsw] DRY RUN — would run:\n  ${HNSW_SQL}`);
      return;
    }
    await pg.query(HNSW_SQL);
    console.log("[hnsw] index created (memory_chunk_embedding_hnsw). Run the recall-parity benchmark before flipping memory_index_kind=hnsw per tenant.");
  } finally {
    await pg.end();
  }
}

main().catch((e) => {
  console.error("[hnsw] fatal:", e);
  process.exit(1);
});
