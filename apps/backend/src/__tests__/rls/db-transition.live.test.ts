import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PROD_REF = "wmycgyjsenvgtczlupoe";
const SHOULD_RUN = !!(SUPA_URL && SUPA_SERVICE) && !SUPA_URL!.includes(PROD_REF);

describe.skipIf(!SHOULD_RUN)("_reset_db_policy_for_transition (live)", () => {
  let svc: SupabaseClient;
  let tenantId = "";

  beforeAll(async () => {
    svc = createClient(SUPA_URL!, SUPA_SERVICE!, { auth: { persistSession: false } });
    const { data, error } = await svc.from("tenants").insert({ display_name: "transition", kind: "test", slug: `transition-${Date.now()}` }).select("id").single();
    if (error || !data) throw new Error(`tenant insert failed: ${error?.message}`);
    tenantId = data.id as string;
    await svc.from("tenant_db_config").insert({
      tenant_id: tenantId,
      type: "postgres",
      schema_map: {},
      auto_hide: false,
      hidden_fields: ["users.phone"],
      disabled_tables: ["audit"],
      unhidden_fields: ["users.email"],
      settings_confirmed_at: new Date().toISOString(),
      policy_catalog_hash: "old",
    });
    await svc.rpc("set_tenant_db_catalog", {
      p_tenant_id: tenantId,
      p_dialect: "postgres",
      p_catalog: { tables: [{ name: "users", columns: [] }] },
      p_hints: {},
      p_discovery_error: null,
      p_coverage: {},
    });
  });

  afterAll(async () => {
    if (tenantId) await svc.from("tenants").delete().eq("id", tenantId);
  });

  it("deletes the catalog, re-enables auto-hide, unconfirms settings, keeps restrictive lists", async () => {
    const { error } = await svc.rpc("_reset_db_policy_for_transition", { p_tenant_id: tenantId });
    expect(error).toBeNull();
    const { data: cat } = await svc.from("tenant_db_catalog").select("tenant_id").eq("tenant_id", tenantId);
    expect(cat ?? []).toHaveLength(0);
    const { data: cfg } = await svc
      .from("tenant_db_config")
      .select("auto_hide, settings_confirmed_at, hidden_fields, disabled_tables, unhidden_fields")
      .eq("tenant_id", tenantId)
      .single();
    expect(cfg).toMatchObject({ auto_hide: true, settings_confirmed_at: null, hidden_fields: ["users.phone"], disabled_tables: ["audit"] });
  });
});
