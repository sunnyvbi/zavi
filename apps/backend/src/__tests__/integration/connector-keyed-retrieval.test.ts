import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { writeNote } from "@/services/memory";

const isIntegration = process.env.INTEGRATION === "1";
const sb: SupabaseClient | null = isIntegration
  ? createClient(
      process.env.SUPABASE_URL || "http://127.0.0.1:54321",
      process.env.SUPABASE_SERVICE_ROLE_KEY || "service-role-key-from-supabase-status",
    )
  : null;

const TENANT_ID = "a4a4a4a4-0000-4000-8000-00000000a4a4";
const TENANT_SLUG = "connector-keyed-itest";

const CUS_KEY = "stripe_customer:cus_X";

function vec(fill: (i: number) => number): number[] {
  return Array.from({ length: 1024 }, (_, i) => fill(i));
}
const N2_EMB = vec((i) => (i === 0 ? 1 : 0));
const N1_EMB = vec((i) => (i === 1 ? 1 : 0));
const QUERY_EMB = vec((i) => (i === 0 ? 1 : 0));

async function seedNoteWithChunk(opts: {
  title: string;
  body: string;
  embedding: number[];
  connectorKeys: string[];
}): Promise<string> {
  const { data: noteRow, error: noteErr } = await sb!
    .from("memory_note")
    .insert({
      tenant_id: TENANT_ID,
      title: opts.title,
      body_markdown: opts.body,
      source: "agent_run",
      source_ref: "connector-keyed-itest",
      note_type: "tenant_reference",
      connector_object_keys: opts.connectorKeys,
    })
    .select("id")
    .single();
  if (noteErr) throw new Error(`fixture note insert failed: ${noteErr.message}`);
  const noteId = (noteRow as { id: string }).id;

  const { error: chunkErr } = await sb!.from("memory_chunk").insert({
    tenant_id: TENANT_ID,
    note_id: noteId,
    chunk_index: 0,
    body: opts.body,
    embedding: JSON.stringify(opts.embedding),
  });
  if (chunkErr) throw new Error(`fixture chunk insert failed: ${chunkErr.message}`);
  return noteId;
}

async function cleanup() {
  await sb!.from("memory_chunk").delete().eq("tenant_id", TENANT_ID);
  await sb!.from("memory_note").delete().eq("tenant_id", TENANT_ID);
}

describe.skipIf(!isIntegration)("connector-keyed retrieval (integration)", () => {
  let n1Id = "";
  let n2Id = "";

  beforeAll(async () => {
    const { error } = await sb!
      .from("tenants")
      .upsert({ id: TENANT_ID, slug: TENANT_SLUG, display_name: "Connector-Keyed ITest" });
    if (error) throw new Error(`fixture tenant upsert failed: ${error.message}`);
    await cleanup();

    n1Id = await seedNoteWithChunk({
      title: "Payout schedule note",
      body: "Internal record about the customer's monthly payout schedule.",
      embedding: N1_EMB,
      connectorKeys: [CUS_KEY],
    });
    n2Id = await seedNoteWithChunk({
      title: "General onboarding doc",
      body: "Generic onboarding reference shared across all customers.",
      embedding: N2_EMB,
      connectorKeys: [],
    });
  });

  afterAll(async () => {
    await cleanup();
    await sb!.from("tenants").delete().eq("id", TENANT_ID);
  });

  it("WITHOUT the prefilter, the higher-cosine untagged note (N2) ranks first", async () => {
    const { data, error } = await sb!.rpc("memory_search_hybrid", {
      p_tenant_id: TENANT_ID,
      p_query: "payout schedule for this customer",
      p_query_embedding: JSON.stringify(QUERY_EMB),
      p_limit: 3,
      p_agent_slug: null,
      p_connector_keys: null,
    });
    if (error) throw new Error(`memory_search_hybrid (no prefilter) failed: ${error.message}`);
    const ids = (data as Array<{ note_id: string }>).map((r) => r.note_id);
    expect(ids).toContain(n2Id);
    if (ids.includes(n1Id)) {
      expect(ids.indexOf(n2Id)).toBeLessThan(ids.indexOf(n1Id));
    }
  });

  it("WITH connector_keys=['stripe_customer:cus_X'], the tagged low-cosine note (N1) is returned and the untagged note (N2) is excluded", async () => {
    const { data, error } = await sb!.rpc("memory_search_hybrid", {
      p_tenant_id: TENANT_ID,
      p_query: "payout schedule for this customer",
      p_query_embedding: JSON.stringify(QUERY_EMB),
      p_limit: 3,
      p_agent_slug: null,
      p_connector_keys: [CUS_KEY],
    });
    if (error) throw new Error(`memory_search_hybrid (prefilter) failed: ${error.message}`);
    const ids = (data as Array<{ note_id: string }>).map((r) => r.note_id);
    expect(ids).toContain(n1Id);
    expect(ids).not.toContain(n2Id);
  });

  it("writeNote persists connector_object_keys and dedup-merge unions them", async () => {
    const { note_id } = await writeNote(TENANT_ID, {
      title: "Connector write test",
      body_markdown: "A distinct fact tagged to a slack channel and a customer.",
      source: "agent_run",
      source_ref: "connector-keyed-itest-write",
      note_type: "tenant_reference",
      connector_object_keys: ["slack_channel:C999"],
    });
    const { data: row1 } = await sb!
      .from("memory_note")
      .select("connector_object_keys")
      .eq("id", note_id)
      .single();
    expect((row1 as { connector_object_keys: string[] }).connector_object_keys).toEqual([
      "slack_channel:C999",
    ]);

    const { note_id: note_id2 } = await writeNote(TENANT_ID, {
      title: "Connector write test",
      body_markdown: "A distinct fact tagged to a slack channel and a customer.",
      source: "agent_run",
      source_ref: "connector-keyed-itest-write",
      note_type: "tenant_reference",
      connector_object_keys: ["stripe_customer:cus_Y"],
    });
    expect(note_id2).toBe(note_id);
    const { data: row2 } = await sb!
      .from("memory_note")
      .select("connector_object_keys")
      .eq("id", note_id)
      .single();
    const keys = (row2 as { connector_object_keys: string[] }).connector_object_keys;
    expect(keys).toContain("slack_channel:C999");
    expect(keys).toContain("stripe_customer:cus_Y");
    expect(keys.length).toBe(2);
  });
});
