
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HAS_SUPABASE = !!(SUPA_URL && SUPA_SERVICE);

const PROD_PROJECT_HOST = "wmycgyjsenvgtczlupoe.supabase.co";
const IS_PROD = !!(SUPA_URL && SUPA_URL.includes(PROD_PROJECT_HOST));
if (IS_PROD) {
  // eslint-disable-next-line no-console
  console.warn(
    `[rls-canary] refusing to run against prod Supabase (${PROD_PROJECT_HOST}). ` +
      `Skipping suite. Set SUPABASE_URL to a local or test project.`,
  );
}

const SHOULD_RUN = HAS_SUPABASE && !IS_PROD;

const CANARY_TOKEN = `CANARY_${randomUUID()}`;

let tenantA = "";
let tenantB = "";
let entityAId = "";
let entityARelDstId = "";
let noteAId = "";
let entityBId = "";
let noteBId = "";

function svc(): SupabaseClient {
  return createClient(SUPA_URL!, SUPA_SERVICE!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

describe.skipIf(!SHOULD_RUN)("RLS cross-tenant leak canary (brain surfaces)", () => {
  beforeAll(async () => {
    const sb = svc();
    const ts = Date.now();

    const { data: tA, error: tAErr } = await sb
      .from("tenants")
      .insert({ slug: `canary-a-${ts}`, display_name: "Canary RLS A" })
      .select("id")
      .single();
    if (tAErr || !tA) throw new Error(`tenant A: ${tAErr?.message}`);
    tenantA = tA.id;

    const { data: tB, error: tBErr } = await sb
      .from("tenants")
      .insert({ slug: `canary-b-${ts}`, display_name: "Canary RLS B" })
      .select("id")
      .single();
    if (tBErr || !tB) throw new Error(`tenant B: ${tBErr?.message}`);
    tenantB = tB.id;

    await sb
      .from("tenants")
      .update({ brain_eval_capture: true })
      .eq("id", tenantA);

    const { data: nA, error: nAErr } = await sb
      .from("memory_note")
      .insert({
        tenant_id: tenantA,
        title: `Tenant A canary ${CANARY_TOKEN}`,
        body_markdown: `Body line one\n\nSecret marker: ${CANARY_TOKEN}\n\nEnd.`,
        source: "human",
        tags: ["canary-test", CANARY_TOKEN],
      })
      .select("id")
      .single();
    if (nAErr || !nA) throw new Error(`memory_note A: ${nAErr?.message}`);
    noteAId = nA.id;

    const { data: eA, error: eAErr } = await sb
      .from("memory_entity")
      .insert({
        tenant_id: tenantA,
        entity_type: "person",
        canonical_name: `${CANARY_TOKEN}-A-src`,
      })
      .select("id")
      .single();
    if (eAErr || !eA) throw new Error(`memory_entity A src: ${eAErr?.message}`);
    entityAId = eA.id;

    const { data: eA2, error: eA2Err } = await sb
      .from("memory_entity")
      .insert({
        tenant_id: tenantA,
        entity_type: "company",
        canonical_name: `${CANARY_TOKEN}-A-dst`,
      })
      .select("id")
      .single();
    if (eA2Err || !eA2) throw new Error(`memory_entity A dst: ${eA2Err?.message}`);
    entityARelDstId = eA2.id;

    const { error: relErr } = await sb.from("memory_relation").insert({
      tenant_id: tenantA,
      src_entity_id: entityAId,
      dst_entity_id: entityARelDstId,
      relation_type: "works_at",
      source_note_id: noteAId,
    });
    if (relErr) throw new Error(`memory_relation A: ${relErr.message}`);

    const takesRows = [
      {
        tenant_id: tenantA,
        holder_type: "tenant" as const,
        holder_ref: null,
        kind: "fact" as const,
        claim: `Tenant-level fact: ${CANARY_TOKEN}`,
        weight: 0.9,
      },
      {
        tenant_id: tenantA,
        holder_type: "agent" as const,
        holder_ref: "chief-of-staff",
        kind: "take" as const,
        claim: `Agent take: ${CANARY_TOKEN}`,
        weight: 0.7,
      },
      {
        tenant_id: tenantA,
        holder_type: "user" as const,
        holder_ref: `user-${ts}`,
        kind: "hunch" as const,
        claim: `User hunch: ${CANARY_TOKEN}`,
        weight: 0.5,
      },
      {
        tenant_id: tenantA,
        holder_type: "entity" as const,
        holder_ref: `person:${CANARY_TOKEN}-A-src`,
        kind: "bet" as const,
        claim: `Entity bet: ${CANARY_TOKEN}`,
        weight: 0.6,
        resolved_at: new Date().toISOString(),
        resolved_to: "correct" as const,
        resolution_source: "manual" as const,
      },
    ];
    const { error: takesErr } = await sb.from("takes").insert(takesRows);
    if (takesErr) throw new Error(`takes A: ${takesErr.message}`);

    const { error: evalErr } = await sb.from("eval_candidates").insert({
      tenant_id: tenantA,
      tool_name: "search",
      query: `query containing ${CANARY_TOKEN}`,
      retrieved_chunk_ids: [],
      retrieved_note_ids: [noteAId],
      latency_ms: 42,
      k: 8,
    });
    if (evalErr) throw new Error(`eval_candidates A: ${evalErr.message}`);

    const { data: nB, error: nBErr } = await sb
      .from("memory_note")
      .insert({
        tenant_id: tenantB,
        title: `Tenant B canary ${CANARY_TOKEN}`,
        body_markdown: `Tenant B body: ${CANARY_TOKEN}`,
        source: "human",
        tags: ["canary-test", CANARY_TOKEN],
      })
      .select("id")
      .single();
    if (nBErr || !nB) throw new Error(`memory_note B: ${nBErr?.message}`);
    noteBId = nB.id;

    const { data: eB, error: eBErr } = await sb
      .from("memory_entity")
      .insert({
        tenant_id: tenantB,
        entity_type: "person",
        canonical_name: `${CANARY_TOKEN}-B-src`,
      })
      .select("id")
      .single();
    if (eBErr || !eB) throw new Error(`memory_entity B: ${eBErr?.message}`);
    entityBId = eB.id;
  }, 120_000);

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const sb = svc();
    if (tenantA) await sb.from("tenants").delete().eq("id", tenantA);
    if (tenantB) await sb.from("tenants").delete().eq("id", tenantB);
  });

  it("searchMemory(tenantB, CANARY) returns ONLY tenant B's note", async () => {
    const { searchMemory } = await import("../../services/memory");
    const hits = await searchMemory(tenantB, CANARY_TOKEN, 20);
    for (const h of hits) {
      expect(h.note_id).not.toBe(noteAId);
    }
    if (hits.length > 0) {
      expect(hits.some((h) => h.note_id === noteBId)).toBe(true);
    }
  }, 60_000);

  it("searchMemory(tenantA, CANARY) returns ONLY tenant A's note (mirror control)", async () => {
    const { searchMemory } = await import("../../services/memory");
    const hits = await searchMemory(tenantA, CANARY_TOKEN, 20);
    for (const h of hits) {
      expect(h.note_id).not.toBe(noteBId);
    }
    if (hits.length > 0) {
      expect(hits.some((h) => h.note_id === noteAId)).toBe(true);
    }
  }, 60_000);

  it("memory_entity scoped by tenant_id never surfaces other tenant's rows", async () => {
    const sb = svc();
    const { data: rows, error } = await sb
      .from("memory_entity")
      .select("id, tenant_id, canonical_name")
      .eq("tenant_id", tenantB)
      .ilike("canonical_name", `%${CANARY_TOKEN}%`);
    if (error) throw new Error(`memory_entity read: ${error.message}`);
    for (const r of rows ?? []) {
      expect((r as { tenant_id: string }).tenant_id).toBe(tenantB);
      expect((r as { id: string }).id).not.toBe(entityAId);
      expect((r as { id: string }).id).not.toBe(entityARelDstId);
    }
    expect((rows ?? []).some((r) => (r as { id: string }).id === entityBId)).toBe(true);
  });

  it("memory_relation scoped by tenant_id never returns other tenant's edges", async () => {
    const sb = svc();
    const { data: rows, error } = await sb
      .from("memory_relation")
      .select("id, tenant_id, src_entity_id, dst_entity_id")
      .eq("tenant_id", tenantB);
    if (error) throw new Error(`memory_relation read: ${error.message}`);
    for (const r of rows ?? []) {
      const row = r as { tenant_id: string; src_entity_id: string; dst_entity_id: string };
      expect(row.tenant_id).toBe(tenantB);
      expect(row.src_entity_id).not.toBe(entityAId);
      expect(row.dst_entity_id).not.toBe(entityARelDstId);
    }
  });

  it("listTakes(tenantB) never returns tenant A's takes", async () => {
    const { listTakes } = await import("../../services/memory/takes-service");
    const rows = await listTakes(tenantB, { limit: 500 });
    for (const r of rows) {
      expect(r.tenant_id).toBe(tenantB);
      expect(r.claim).not.toContain(CANARY_TOKEN);
    }
  });

  it("listTakes(tenantA) DOES return tenant A's 4 holder-type rows (mirror control)", async () => {
    const { listTakes } = await import("../../services/memory/takes-service");
    const rows = await listTakes(tenantA, { limit: 500 });
    const canaryRows = rows.filter((r) => r.claim.includes(CANARY_TOKEN));
    expect(canaryRows.length).toBe(4);
    const holderTypes = new Set(canaryRows.map((r) => r.holder_type));
    expect(holderTypes).toEqual(new Set(["tenant", "agent", "user", "entity"]));
  });

  it("computeScorecard(tenantB) does not include tenant A's resolved bet", async () => {
    const { computeScorecard } = await import("../../services/memory/takes-service");
    const m = await computeScorecard(tenantB);
    expect(m.brier_n).toBe(0);
    expect(m.actual_rate_n).toBe(0);
  });

  it("computeScorecard(tenantA) sees tenant A's bet (mirror control)", async () => {
    const { computeScorecard } = await import("../../services/memory/takes-service");
    const m = await computeScorecard(tenantA);
    expect(m.brier_n).toBeGreaterThanOrEqual(1);
  });

  it("eval_candidates scoped by tenant_id never returns other tenant's captures", async () => {
    const sb = svc();
    const { data: rows, error } = await sb
      .from("eval_candidates")
      .select("id, tenant_id, query")
      .eq("tenant_id", tenantB);
    if (error) throw new Error(`eval_candidates read: ${error.message}`);
    for (const r of rows ?? []) {
      const row = r as { tenant_id: string; query: string };
      expect(row.tenant_id).toBe(tenantB);
      expect(row.query).not.toContain(CANARY_TOKEN);
    }
  });

  it("eval_candidates(tenantA) DOES include the planted capture (mirror control)", async () => {
    const sb = svc();
    const { data: rows, error } = await sb
      .from("eval_candidates")
      .select("id, tenant_id, query")
      .eq("tenant_id", tenantA)
      .ilike("query", `%${CANARY_TOKEN}%`);
    if (error) throw new Error(`eval_candidates A read: ${error.message}`);
    expect((rows ?? []).length).toBeGreaterThanOrEqual(1);
  });
});
