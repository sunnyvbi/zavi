
import { createClient } from "@supabase/supabase-js";
import { embedTexts } from "@/services/memory/embed";
import { buildChunkContextPrefix } from "@/services/memory/contextualize";

const BATCH = 64;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}
const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT_ARG = arg("--limit");
const LIMIT = LIMIT_ARG ? Number(LIMIT_ARG) : Infinity;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_ARG = arg("--tenant");
const TENANT = TENANT_ARG && UUID_RE.test(TENANT_ARG) ? TENANT_ARG : undefined;
if (TENANT_ARG && !TENANT) {
  console.error(`[ctx-backfill] --tenant value is not a valid uuid: ${JSON.stringify(TENANT_ARG)}`);
  process.exit(2);
}

type ChunkRow = {
  id: string;
  tenant_id: string;
  note_id: string;
  body: string;
  context_text: string | null;
  embedding: number[] | null;
};

type NoteMeta = { note_type: string | null; title: string | null };

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Run with `node --env-file=.env ...`",
    );
    process.exit(2);
  }
  const sb = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  {
    let q = sb.from("memory_chunk").select("*", { count: "exact", head: true });
    if (TENANT) q = q.eq("tenant_id", TENANT);
    const { count } = await q;
    console.log(
      `[ctx-backfill] chunks in scope: ${count ?? "?"}${TENANT ? ` (tenant ${TENANT})` : " (all tenants)"}`,
    );
  }

  let processed = 0;
  let reembedded = 0;
  let skipped = 0;
  let failed = 0;
  let afterId: string | null = null;

  while (processed < LIMIT) {
    const remaining = Math.min(BATCH, LIMIT - processed);
    let q = sb
      .from("memory_chunk")
      .select("id, tenant_id, note_id, body, context_text, embedding")
      .order("id", { ascending: true })
      .limit(remaining);
    if (afterId !== null) q = q.gt("id", afterId);
    if (TENANT) q = q.eq("tenant_id", TENANT);
    const { data, error } = await q;
    if (error) {
      console.error(`[ctx-backfill] scan failed: ${error.message}`);
      process.exit(1);
    }
    const rows = (data ?? []) as ChunkRow[];
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1].id;

    const noteIds = Array.from(new Set(rows.map((r) => r.note_id)));
    const { data: noteData, error: noteErr } = await sb
      .from("memory_note")
      .select("id, note_type, title")
      .in("id", noteIds);
    if (noteErr) {
      console.error(`[ctx-backfill] note meta fetch failed: ${noteErr.message}`);
      process.exit(1);
    }
    const noteMeta = new Map<string, NoteMeta>();
    for (const n of (noteData ?? []) as Array<{ id: string; note_type: string | null; title: string | null }>) {
      noteMeta.set(n.id, { note_type: n.note_type, title: n.title });
    }

    const needWork: Array<{ row: ChunkRow; desired: string }> = [];
    for (const row of rows) {
      processed += 1;
      const meta = noteMeta.get(row.note_id) ?? { note_type: null, title: null };
      const prefix = buildChunkContextPrefix({ note_type: meta.note_type, title: meta.title });
      const desired = `${prefix}${row.body}`;
      const upToDate = row.context_text === desired && row.embedding != null;
      if (upToDate) {
        skipped += 1;
        continue;
      }
      needWork.push({ row, desired });
    }

    if (needWork.length === 0) {
      console.log(`[ctx-backfill] processed=${processed} reembedded=${reembedded} skipped=${skipped} failed=${failed}`);
      continue;
    }

    if (DRY_RUN) {
      reembedded += needWork.length;
      console.log(
        `[ctx-backfill][dry-run] would re-embed ${needWork.length} chunk(s) in this batch. ` +
          `sample desired context_text: ${JSON.stringify(needWork[0].desired.slice(0, 120))}`,
      );
      console.log(`[ctx-backfill] processed=${processed} reembedded(planned)=${reembedded} skipped=${skipped}`);
      continue;
    }

    let vectors: number[][];
    try {
      vectors = await embedTexts(needWork.map((w) => w.desired), "document");
    } catch (e) {
      console.error(`[ctx-backfill] embed batch failed:`, e);
      process.exit(1);
    }

    for (let i = 0; i < needWork.length; i++) {
      const { row, desired } = needWork[i];
      const v = vectors[i];
      if (!v) {
        failed += 1;
        continue;
      }
      const { error: upErr } = await sb
        .from("memory_chunk")
        .update({ context_text: desired, embedding: v })
        .eq("id", row.id)
        .eq("tenant_id", row.tenant_id);
      if (upErr) {
        console.warn(`[ctx-backfill] update failed for chunk ${row.id}: ${upErr.message}`);
        failed += 1;
        continue;
      }
      reembedded += 1;
    }
    console.log(`[ctx-backfill] processed=${processed} reembedded=${reembedded} skipped=${skipped} failed=${failed}`);
  }

  console.log(
    `[ctx-backfill] DONE${DRY_RUN ? " (dry-run)" : ""}. processed=${processed} reembedded=${reembedded} skipped=${skipped} failed=${failed}`,
  );
}

main().catch((e) => {
  console.error("[ctx-backfill] uncaught:", e);
  process.exit(1);
});
