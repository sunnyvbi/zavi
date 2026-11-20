import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PROD_REF = "wmycgyjsenvgtczlupoe";
const SHOULD_RUN = !!(SUPA_URL && SUPA_SERVICE) && !SUPA_URL!.includes(PROD_REF);

describe.skipIf(!SHOULD_RUN)("database source/policy generation (live)", () => {
  let svc: SupabaseClient;
  let tenantId = "";
  let connectorId = "";
  const gen = async () => Number((await svc.from("tenant_db_generation").select("generation").eq("tenant_id", tenantId).maybeSingle()).data?.generation ?? 0);
  const reserve = (generation: number | null) =>
    svc.rpc("reserve_data_access", {
      p_tenant_id: tenantId, p_generation: generation, p_caller_kind: "background", p_agent_slug: null, p_run_id: null,
      p_tool_name: null, p_feature: "Booking metrics", p_user_id: null, p_mode: "direct", p_dialect: "postgres",
      p_operation: "read", p_query_text: "select 1", p_tables: ["users"],
    });
  const catalog = { tables: [{ name: "users", columns: [{ name: "id", type: "integer", nullable: false }] }] };

  beforeAll(async () => {
    svc = createClient(SUPA_URL!, SUPA_SERVICE!, { auth: { persistSession: false } });
    const { data, error } = await svc.from("tenants").insert({ display_name: "generation", kind: "test", slug: `generation-${Date.now()}` }).select("id").single();
    if (error || !data) throw new Error(`tenant insert failed: ${error?.message}`);
    tenantId = data.id as string;
    await svc.from("tenant_db_config").insert({ tenant_id: tenantId, type: "postgres", schema_map: {}, mode: "connector" });
    const c = await svc.from("db_connectors").insert({ tenant_id: tenantId, token_hash: "e".repeat(64), dialect: "postgres", last_seen_at: new Date().toISOString() }).select("id").single();
    if (c.error || !c.data) throw new Error(`connector insert failed: ${c.error?.message}`);
    connectorId = c.data.id as string;
  });

  afterAll(async () => {
    if (tenantId) await svc.from("tenants").delete().eq("id", tenantId);
  });

  it("a visibility change bumps the generation; an identical write does not", async () => {
    const g0 = await gen();
    await svc.from("tenant_db_config").update({ hidden_fields: ["users.email"] }).eq("tenant_id", tenantId);
    const g1 = await gen();
    expect(g1).toBeGreaterThan(g0);
    await svc.from("tenant_db_config").update({ hidden_fields: ["users.email"] }).eq("tenant_id", tenantId);
    expect(await gen()).toBe(g1);
  });

  it("a read reserved under an old generation is refused before it runs", async () => {
    const g = await gen();
    expect((await reserve(g)).error).toBeNull();
    expect((await reserve(g - 1)).error?.code).toBe("ZD412");
    expect((await reserve(null)).error).toBeNull();
  });

  it("an allowed result finalized after a transition is discarded and recorded so", async () => {
    const g = await gen();
    const { data: id } = await reserve(g);
    await svc.from("tenant_db_config").update({ disabled_tables: ["audit"] }).eq("tenant_id", tenantId);
    const fin = await svc.rpc("finalize_data_access", {
      p_tenant_id: tenantId, p_id: id, p_generation: g, p_result: "allowed", p_row_count: 3, p_sent_to_ai: true,
      p_refused_by: null, p_reason: null, p_totals_only: false, p_ms: 5,
    });
    expect(fin.data).toBe("source_changed");
    const row = (await svc.from("data_access_log").select("result, sent_to_ai, row_count").eq("id", id).single()).data;
    expect(row).toEqual({ result: "failed", sent_to_ai: false, row_count: 0 });
  });

  it("a stale discovery loses its compare-and-set (catalog write and failure stamp)", async () => {
    const g = await gen();
    const ok = await svc.rpc("set_tenant_db_catalog", { p_tenant_id: tenantId, p_dialect: "postgres", p_catalog: catalog, p_hints: {}, p_discovery_error: null, p_coverage: {}, p_generation: g });
    expect(ok.data).toBe(true);
    const stale = await svc.rpc("set_tenant_db_catalog", { p_tenant_id: tenantId, p_dialect: "postgres", p_catalog: { tables: [] }, p_hints: {}, p_discovery_error: null, p_coverage: {}, p_generation: g - 1 });
    expect(stale.data).toBe(false);
    expect((await svc.rpc("stamp_tenant_db_discovery_error", { p_tenant_id: tenantId, p_error: "boom", p_generation: g - 1 })).data).toBe(false);
    const cat = (await svc.from("tenant_db_catalog").select("catalog, discovery_error").eq("tenant_id", tenantId).single()).data;
    expect(cat).toMatchObject({ discovery_error: null });
    expect((cat!.catalog as { tables: unknown[] }).tables).toHaveLength(1);
  });

  it("a connector source change resets the catalog, fails queued reads and bumps the generation", async () => {
    const src1 = "1".repeat(32);
    const src2 = "2".repeat(32);
    await svc.rpc("touch_db_connector", { p_tenant_id: tenantId, p_connector_id: connectorId, p_machine: "m", p_version: "1", p_rules: null, p_rules_hash: null, p_source_instance_id: src1 });
    const g = await gen();
    await svc.rpc("set_tenant_db_catalog", { p_tenant_id: tenantId, p_dialect: "postgres", p_catalog: catalog, p_hints: {}, p_discovery_error: null, p_coverage: {}, p_generation: g });
    const req = await svc.rpc("enqueue_db_connector_request", { p_tenant_id: tenantId, p_op: { op: "describe" }, p_ttl_seconds: 60, p_generation: g });
    expect(req.error).toBeNull();
    const t = await svc.rpc("touch_db_connector", { p_tenant_id: tenantId, p_connector_id: connectorId, p_machine: "m", p_version: "1", p_rules: null, p_rules_hash: null, p_source_instance_id: src2 });
    expect((t.data as Array<{ source_changed: boolean }>)[0]!.source_changed).toBe(true);
    expect(await gen()).toBeGreaterThan(g);
    expect((await svc.from("tenant_db_catalog").select("tenant_id").eq("tenant_id", tenantId)).data).toEqual([]);
    const r = (await svc.from("db_connector_requests").select("status, reason").eq("id", req.data).single()).data;
    expect(r).toEqual({ status: "failed", reason: "source_changed" });
  });

  it("a result from another source or generation is never stored", async () => {
    const g = await gen();
    const req = await svc.rpc("enqueue_db_connector_request", { p_tenant_id: tenantId, p_op: { op: "describe" }, p_ttl_seconds: 60, p_generation: g });
    const claim = await svc.rpc("claim_db_connector_request", { p_tenant_id: tenantId, p_connector_id: connectorId });
    const d = (claim.data as Array<{ id: string; execution_token: string; generation: number }>)[0]!;
    expect(d.id).toBe(req.data);
    expect(Number(d.generation)).toBe(g);
    const out = await svc.rpc("complete_db_connector_request", {
      p_tenant_id: tenantId, p_connector_id: connectorId, p_request_id: d.id, p_execution_token: d.execution_token,
      p_status: "done", p_result: { status: "done" }, p_reason: null, p_generation: g, p_source_instance_id: "9".repeat(32),
    });
    expect(out.data).toBe("source_changed");
    const row = (await svc.from("db_connector_requests").select("status, result").eq("id", d.id).single()).data;
    expect(row).toEqual({ status: "failed", result: null });
  });

  it("a disconnect bumps the generation (the number survives the deleted config)", async () => {
    const g = await gen();
    await svc.from("tenant_db_config").delete().eq("tenant_id", tenantId);
    expect(await gen()).toBeGreaterThan(g);
  });
});
