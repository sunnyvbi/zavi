import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  extractEntitiesAndRelations,
  type TypedExtractClient,
} from "@/services/memory/extract";
import { persistTypedGraph } from "@/services/memory";

const isIntegration = process.env.INTEGRATION === "1";
const sb: SupabaseClient | null = isIntegration
  ? createClient(
      process.env.SUPABASE_URL || "http://127.0.0.1:54321",
      process.env.SUPABASE_SERVICE_ROLE_KEY || "service-role-key-from-supabase-status",
    )
  : null;

const TENANT_ID = "a3a3a3a3-0000-4000-8000-00000000a3a3";
const TENANT_SLUG = "relationship-graph-itest";

const FAKE_MODEL_OUTPUT = JSON.stringify({
  entities: [
    { canonical: "Acme Corp", type: "company" },
    { canonical: "Jane Doe", type: "person" },
  ],
  relations: [{ from: "Acme Corp", to: "Jane Doe", type: "signed" }],
});

const fakeClient: TypedExtractClient = {
  messages: {
    create: async () => ({ content: [{ type: "text", text: FAKE_MODEL_OUTPUT }] }),
  },
};

async function insertFixtureNote(): Promise<string> {
  const { data, error } = await sb!
    .from("memory_note")
    .insert({
      tenant_id: TENANT_ID,
      title: "Acme deal",
      body_markdown: "Acme Corp signed Jane Doe as VP.",
      source: "agent_run",
      source_ref: "relationship-graph-itest",
    })
    .select("id")
    .single();
  if (error) throw new Error(`fixture note insert failed: ${error.message}`);
  return (data as { id: string }).id;
}

describe.skipIf(!isIntegration)("relationship graph revival (integration)", () => {
  beforeAll(async () => {
    const { error } = await sb!
      .from("tenants")
      .upsert({ id: TENANT_ID, slug: TENANT_SLUG, display_name: "Relationship Graph ITest" });
    if (error) throw new Error(`fixture tenant upsert failed: ${error.message}`);
    await sb!.from("memory_relation").delete().eq("tenant_id", TENANT_ID);
    await sb!.from("memory_entity").delete().eq("tenant_id", TENANT_ID);
    await sb!.from("memory_note").delete().eq("tenant_id", TENANT_ID);
  });

  afterAll(async () => {
    await sb!.from("memory_relation").delete().eq("tenant_id", TENANT_ID);
    await sb!.from("memory_entity").delete().eq("tenant_id", TENANT_ID);
    await sb!.from("memory_note").delete().eq("tenant_id", TENANT_ID);
    await sb!.from("tenants").delete().eq("id", TENANT_ID);
  });

  it("persists >=2 typed entities + >=1 relation for the synthetic note", async () => {
    const noteId = await insertFixtureNote();

    const graph = await extractEntitiesAndRelations(
      "Acme Corp signed Jane Doe as VP.",
      TENANT_ID,
      { client: fakeClient },
    );
    expect(graph.entities.length).toBeGreaterThanOrEqual(2);
    expect(graph.relations.length).toBeGreaterThanOrEqual(1);

    const persisted = await persistTypedGraph(TENANT_ID, noteId, graph);
    expect(persisted.entities).toBeGreaterThanOrEqual(2);
    expect(persisted.relations).toBeGreaterThanOrEqual(1);

    const { count: typedEntities } = await sb!
      .from("memory_entity")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", TENANT_ID)
      .in("entity_type", ["person", "company"]);

    const { count: relations } = await sb!
      .from("memory_relation")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", TENANT_ID);

    expect(typedEntities ?? 0).toBeGreaterThanOrEqual(2);
    expect(relations ?? 0).toBeGreaterThanOrEqual(1);

    const { data: rows } = await sb!
      .from("memory_entity")
      .select("entity_type, canonical_name")
      .eq("tenant_id", TENANT_ID);
    const types = new Set((rows ?? []).map((r) => (r as { entity_type: string }).entity_type));
    expect(types.has("company")).toBe(true);
    expect(types.has("person")).toBe(true);
    expect(types.has("generic")).toBe(false);

    const { data: rel } = await sb!
      .from("memory_relation")
      .select("relation_type, link_source, source_note_id")
      .eq("tenant_id", TENANT_ID)
      .limit(1)
      .maybeSingle();
    expect(rel).not.toBeNull();
    expect((rel as { link_source: string }).link_source).toBe("extracted");
    expect((rel as { source_note_id: string }).source_note_id).toBe(noteId);
  });

  it("re-running on the same note replaces (does not accumulate) extracted edges", async () => {
    const noteId = await insertFixtureNote();
    const graph = await extractEntitiesAndRelations("Acme Corp signed Jane Doe.", TENANT_ID, {
      client: fakeClient,
    });
    await persistTypedGraph(TENANT_ID, noteId, graph);
    await persistTypedGraph(TENANT_ID, noteId, graph);

    const { count } = await sb!
      .from("memory_relation")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", TENANT_ID)
      .eq("source_note_id", noteId)
      .eq("link_source", "extracted");
    expect(count ?? 0).toBe(1);
  });

  it("re-distilling to an EMPTY relation set clears the note's prior extracted edges", async () => {
    const noteId = await insertFixtureNote();

    const withEdge = await extractEntitiesAndRelations("Acme Corp signed Jane Doe.", TENANT_ID, {
      client: fakeClient,
    });
    await persistTypedGraph(TENANT_ID, noteId, withEdge);
    const { count: before } = await sb!
      .from("memory_relation")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", TENANT_ID)
      .eq("source_note_id", noteId)
      .eq("link_source", "extracted");
    expect(before ?? 0).toBe(1);

    const noEdgeClient: TypedExtractClient = {
      messages: {
        create: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                entities: [{ canonical: "Acme Corp", type: "company" }],
                relations: [],
              }),
            },
          ],
        }),
      },
    };
    const noEdge = await extractEntitiesAndRelations("Acme Corp is a company.", TENANT_ID, {
      client: noEdgeClient,
    });
    await persistTypedGraph(TENANT_ID, noteId, noEdge);

    const { count: after } = await sb!
      .from("memory_relation")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", TENANT_ID)
      .eq("source_note_id", noteId)
      .eq("link_source", "extracted");
    expect(after ?? 0).toBe(0);
  });
});
