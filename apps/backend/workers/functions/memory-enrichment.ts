
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { embedTexts, VoyageDimError } from "@/services/memory/embed";
import { extractEntities } from "@/services/memory/extract";
import { buildChunkContextPrefix } from "@/services/memory/contextualize";

const CHUNK_BATCH_SIZE = 64;
const NOTE_LOOKBACK_HOURS = 36;

type ChunkRow = { id: string; tenant_id: string; note_id: string; body: string };
type NoteRow = { id: string; tenant_id: string; body_markdown: string };

async function backfillEmbeddings(tenant_id: string): Promise<number> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("memory_chunk")
    .select("id, tenant_id, note_id, body")
    .eq("tenant_id", tenant_id)
    .is("embedding", null)
    .limit(CHUNK_BATCH_SIZE);
  if (error) throw new Error(`memory_chunk scan failed: ${error.message}`);
  const rows = (data ?? []) as ChunkRow[];
  if (rows.length === 0) return 0;

  const noteIds = Array.from(new Set(rows.map((r) => r.note_id)));
  const { data: noteData } = await sb
    .from("memory_note")
    .select("id, note_type, title")
    .in("id", noteIds);
  const noteMeta = new Map<string, { note_type: string | null; title: string | null }>();
  for (const n of (noteData ?? []) as Array<{ id: string; note_type: string | null; title: string | null }>) {
    noteMeta.set(n.id, { note_type: n.note_type, title: n.title });
  }
  const contextTexts = rows.map((r) => {
    const m = noteMeta.get(r.note_id) ?? { note_type: null, title: null };
    return `${buildChunkContextPrefix({ note_type: m.note_type, title: m.title })}${r.body}`;
  });

  let embeddings: number[][] = [];
  try {
    embeddings = await embedTexts(contextTexts, "document");
  } catch (e) {
    if (e instanceof VoyageDimError) throw e;
    console.error(
      `[PRAXIS_EMBED_OUTAGE] memory-enrichment tenant ${tenant_id} embed batch failed — ` +
        `backfill for this batch skipped, will retry next run. Cause:`,
      e,
    );
    return 0;
  }
  let updated = 0;
  for (let i = 0; i < rows.length; i++) {
    const v = embeddings[i];
    if (!v) continue;
    const { error: upErr } = await sb
      .from("memory_chunk")
      .update({ embedding: v, context_text: contextTexts[i] })
      .eq("id", rows[i].id)
      .eq("tenant_id", tenant_id);
    if (upErr) {
      console.warn(`[memory-enrichment] chunk ${rows[i].id} update failed: ${upErr.message}`);
      continue;
    }
    updated += 1;
  }
  return updated;
}

async function backfillEntities(tenant_id: string): Promise<number> {
  const sb = serviceClient();
  const cutoff = new Date(Date.now() - NOTE_LOOKBACK_HOURS * 3600 * 1000).toISOString();
  const { data, error } = await sb
    .from("memory_note")
    .select("id, tenant_id, body_markdown")
    .eq("tenant_id", tenant_id)
    .gte("updated_at", cutoff);
  if (error) throw new Error(`memory_note scan failed: ${error.message}`);
  const rows = (data ?? []) as NoteRow[];
  if (rows.length === 0) return 0;
  let upserted = 0;
  const now = new Date().toISOString();
  for (const note of rows) {
    const { entities } = extractEntities(note.body_markdown);
    for (const e of entities) {
      const { error: entErr } = await sb
        .from("memory_entity")
        .upsert(
          {
            tenant_id,
            entity_type: e.entity_type,
            canonical_name: e.canonical_name,
            attrs: e.attrs ?? {},
            last_seen_at: now,
          },
          { onConflict: "tenant_id,entity_type,canonical_name" },
        );
      if (entErr) continue;
      upserted += 1;
    }
  }
  return upserted;
}

export const memoryEnrichmentFn = inngest.createFunction(
  { id: "memory-enrichment", concurrency: 1 },
  { cron: "0 11 * * *" },
  async ({ logger }) => {
    const { data, error } = await serviceClient().from("tenants").select("id");
    if (error) throw new Error(`tenants scan failed: ${error.message}`);
    const tenant_ids = (data ?? []).map((t) => t.id as string);

    let chunks = 0;
    let entities = 0;
    for (const tenant_id of tenant_ids) {
      try {
        chunks += await backfillEmbeddings(tenant_id);
        entities += await backfillEntities(tenant_id);
      } catch (e) {
        logger.warn(`memory-enrichment: tenant ${tenant_id} failed: ${(e as Error).message}`);
      }
    }
    logger.info(
      `memory-enrichment: ${tenant_ids.length} tenants, +${chunks} embeddings, +${entities} entity upserts`,
    );
    return { tenants: tenant_ids.length, chunks_embedded: chunks, entities_upserted: entities };
  },
);
