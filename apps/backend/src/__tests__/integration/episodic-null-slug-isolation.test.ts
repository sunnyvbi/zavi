import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const isIntegration = process.env.INTEGRATION === "1";
const sb: SupabaseClient | null = isIntegration
  ? createClient(
      process.env.SUPABASE_URL || "http://127.0.0.1:54321",
      process.env.SUPABASE_SERVICE_ROLE_KEY || "service-role-key-from-supabase-status",
    )
  : null;

const TENANT_ID = "e9e9e9e9-0000-4000-8000-00000000e9e9";
const TENANT_SLUG = "episodic-null-slug-itest";

function vec(fill: (i: number) => number): number[] {
  return Array.from({ length: 1024 }, (_, i) => fill(i));
}
const EMB = vec((i) => (i === 0 ? 1 : 0));
const QUERY_EMB = vec((i) => (i === 0 ? 1 : 0));
const SHARED_BODY = "shared widget retention playbook for this customer";
const QUERY_TEXT = "shared widget retention playbook";

async function seedNoteWithChunk(opts: {
  title: string;
  noteType: string;
  agentSlug: string | null;
}): Promise<string> {
  const { data: noteRow, error: noteErr } = await sb!
    .from("memory_note")
    .insert({
      tenant_id: TENANT_ID,
      title: opts.title,
      body_markdown: SHARED_BODY,
      source: "agent_run",
      source_ref: "episodic-null-slug-itest",
      note_type: opts.noteType,
      agent_slug: opts.agentSlug,
    })
    .select("id")
    .single();
  if (noteErr) throw new Error(`fixture note insert failed: ${noteErr.message}`);
  const noteId = (noteRow as { id: string }).id;

  const { error: chunkErr } = await sb!.from("memory_chunk").insert({
    tenant_id: TENANT_ID,
    note_id: noteId,
    chunk_index: 0,
    body: SHARED_BODY,
    embedding: JSON.stringify(EMB),
  });
  if (chunkErr) throw new Error(`fixture chunk insert failed: ${chunkErr.message}`);
  return noteId;
}

async function cleanup() {
  await sb!.from("memory_chunk").delete().eq("tenant_id", TENANT_ID);
  await sb!.from("memory_note").delete().eq("tenant_id", TENANT_ID);
}

async function search(rpc: "memory_search_hybrid" | "memory_search_hybrid_v2", slug: string | null) {
  const { data, error } = await sb!.rpc(rpc, {
    p_tenant_id: TENANT_ID,
    p_query: QUERY_TEXT,
    p_query_embedding: JSON.stringify(QUERY_EMB),
    p_limit: 10,
    p_agent_slug: slug,
    p_connector_keys: null,
  });
  if (error) throw new Error(`${rpc} (slug=${slug}) failed: ${error.message}`);
  return (data as Array<{ note_id: string }>).map((r) => r.note_id);
}

describe.skipIf(!isIntegration)("episodic null-slug isolation (integration)", () => {
  let dId = "";
  let eaId = "";
  let ebId = "";

  beforeAll(async () => {
    const { error } = await sb!
      .from("tenants")
      .upsert({ id: TENANT_ID, slug: TENANT_SLUG, display_name: "Episodic Null-Slug ITest" });
    if (error) throw new Error(`fixture tenant upsert failed: ${error.message}`);
    await cleanup();

    dId = await seedNoteWithChunk({
      title: "Declarative company fact",
      noteType: "tenant_reference",
      agentSlug: null,
    });
    eaId = await seedNoteWithChunk({
      title: "Alpha's private episodic note",
      noteType: "agent_experience",
      agentSlug: "alpha",
    });
    ebId = await seedNoteWithChunk({
      title: "Beta's private episodic note",
      noteType: "agent_experience",
      agentSlug: "beta",
    });
  });

  afterAll(async () => {
    await cleanup();
    await sb!.from("tenants").delete().eq("id", TENANT_ID);
  });

  for (const rpc of ["memory_search_hybrid", "memory_search_hybrid_v2"] as const) {
    describe(rpc, () => {
      it("null slug returns the declarative note but NO agent_experience rows", async () => {
        const ids = await search(rpc, null);
        expect(ids).toContain(dId);
        expect(ids).not.toContain(eaId);
        expect(ids).not.toContain(ebId);
      });

      it("matching slug returns that agent's episodic + declarative, not the other agent's", async () => {
        const ids = await search(rpc, "alpha");
        expect(ids).toContain(dId);
        expect(ids).toContain(eaId);
        expect(ids).not.toContain(ebId);
      });

      it("non-matching slug does NOT return that agent's episodic", async () => {
        const ids = await search(rpc, "beta");
        expect(ids).toContain(dId);
        expect(ids).toContain(ebId);
        expect(ids).not.toContain(eaId);
      });
    });
  }
});
