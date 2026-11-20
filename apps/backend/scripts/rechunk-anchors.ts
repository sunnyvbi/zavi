
import { serviceClient } from "@/services/supabase";
import { upsertAnchor } from "@/services/memory/upsert-anchor";
import type { MemoryDocSlug } from "@/services/memory/loader";
import { MEMORY_SLUGS } from "@/services/memory/loader";

type AnchorRow = {
  tenant_id: string;
  slug: string;
  title: string;
  body_markdown: string;
  source: string;
};

async function main(): Promise<void> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("memory_note")
    .select("tenant_id, slug, title, body_markdown, source")
    .not("slug", "is", null)
    .is("superseded_by", null);
  if (error) {
    throw new Error(`failed to read anchors: ${error.message}`);
  }
  const rows = (data ?? []) as AnchorRow[];
  console.log(`[rechunk-anchors] found ${rows.length} anchor rows to rebuild`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    if (!(MEMORY_SLUGS as readonly string[]).includes(row.slug)) {
      console.warn(`[rechunk-anchors] unknown slug ${row.slug} for tenant ${row.tenant_id}; skipping`);
      skipped += 1;
      continue;
    }
    try {
      const { chunks } = await upsertAnchor({
        tenant_id: row.tenant_id,
        slug: row.slug as MemoryDocSlug,
        title: row.title,
        body_markdown: row.body_markdown,
        source: row.source === "agent_write" ? "agent_write" : "human",
      });
      console.log(`  ok  ${row.tenant_id}/${row.slug} -> ${chunks} chunks`);
      ok += 1;
    } catch (e) {
      console.error(`  fail ${row.tenant_id}/${row.slug}: ${(e as Error).message}`);
      failed += 1;
    }
  }
  console.log(`[rechunk-anchors] done. ok=${ok} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`[rechunk-anchors] fatal: ${(e as Error).message}`);
  process.exit(1);
});
