import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PROD_REF = "wmycgyjsenvgtczlupoe";
const SHOULD_RUN = !!(SUPA_URL && SUPA_SERVICE) && !SUPA_URL!.includes(PROD_REF);

type Row = {
  catalog: { tables?: Array<{ name: string }> };
  catalog_hash: string | null;
  discovery_error: string | null;
  rescan_error: string | null;
  rescan_failed_at: string | null;
  rescan_attempts: number;
  rescan_retry_at: string | null;
  source_epoch: number;
};

describe.skipIf(!SHOULD_RUN)("a failed re-scan keeps the last good catalog (live)", () => {
  let svc: SupabaseClient;
  let tenantId = "";
  const table = (name: string) => ({ name, columns: [{ name: "id", type: "integer", nullable: false }] });
  const good = { tables: [table("users"), table("orders"), table("trips")] };
  const full = { tables_total: 3, tables_indexed: 3, skipped_unsafe_names: 0, deadline_hit: false, listing_truncated: false };

  const gen = async () => Number((await svc.from("tenant_db_generation").select("generation").eq("tenant_id", tenantId).maybeSingle()).data?.generation ?? 0);
  const epoch = async () => Number((await svc.from("tenant_db_generation").select("source_epoch").eq("tenant_id", tenantId).maybeSingle()).data?.source_epoch ?? 0);
  const row = async () =>
    (await svc.from("tenant_db_catalog").select("catalog, catalog_hash, discovery_error, rescan_error, rescan_failed_at, rescan_attempts, rescan_retry_at, source_epoch").eq("tenant_id", tenantId).single()).data as Row;
  const apply = async (p: { catalog?: object; error?: string | null; coverage?: object; generation?: number }) =>
    (
      await svc.rpc("apply_tenant_db_scan", {
        p_tenant_id: tenantId,
        p_dialect: "postgres",
        p_catalog: p.catalog ?? {},
        p_hints: {},
        p_discovery_error: p.error ?? null,
        p_coverage: p.coverage ?? {},
        p_generation: p.generation ?? (await gen()),
      })
    ).data as string;

  beforeAll(async () => {
    svc = createClient(SUPA_URL!, SUPA_SERVICE!, { auth: { persistSession: false } });
    const { data, error } = await svc.from("tenants").insert({ display_name: "rescan", kind: "test", slug: `rescan-${Date.now()}` }).select("id").single();
    if (error || !data) throw new Error(`tenant insert failed: ${error?.message}`);
    tenantId = data.id as string;
    const cfg = await svc.from("tenant_db_config").insert({ tenant_id: tenantId, type: "postgres", schema_map: {}, mode: "direct" });
    if (cfg.error) throw new Error(`config insert failed: ${cfg.error.message}`);
  });

  afterAll(async () => {
    if (tenantId) await svc.from("tenants").delete().eq("id", tenantId);
  });

  it("without a last good catalog a failure is stored as before (reads stay refused)", async () => {
    expect(await apply({ error: "connect ECONNREFUSED" })).toBe("stored_error");
    expect(await row()).toMatchObject({ discovery_error: "connect ECONNREFUSED", rescan_error: null });
  });

  it("a full scan replaces the catalog and stamps the current source epoch", async () => {
    expect(await apply({ catalog: good, coverage: full })).toBe("stored");
    const r = await row();
    expect(r.catalog.tables).toHaveLength(3);
    expect(r).toMatchObject({ discovery_error: null, rescan_error: null, rescan_failed_at: null });
    expect(Number(r.source_epoch)).toBe(await epoch());
  });

  it("a failed re-scan keeps the catalog and its hash, and records why", async () => {
    const before = await row();
    expect(await apply({ error: "PlanExecutor error :: operation exceeded time limit" })).toBe("kept_last_good");
    const r = await row();
    expect(r.catalog).toEqual(before.catalog);
    expect(r.catalog_hash).toBe(before.catalog_hash);
    expect(r.discovery_error).toBeNull();
    expect(r.rescan_error).toMatch(/exceeded time limit/);
    expect(r.rescan_failed_at).not.toBeNull();
    expect(r.rescan_attempts).toBe(1);
    const inMs = Date.parse(r.rescan_retry_at!) - Date.now();
    expect(inMs).toBeGreaterThan(50 * 60_000);
    expect(inMs).toBeLessThan(70 * 60_000);
  });

  it("an empty re-scan keeps the catalog", async () => {
    expect(await apply({ catalog: { tables: [] }, coverage: { ...full, tables_total: 0, tables_indexed: 0 } })).toBe("kept_last_good");
    const r = await row();
    expect(r.catalog.tables).toHaveLength(3);
    expect(r.rescan_error).toMatch(/no tables/);
  });

  it("an unfinished re-scan keeps the catalog even when it read as many tables, and backs off", async () => {
    const swapped = { tables: [table("users"), table("orders"), table("payments")] };
    expect(await apply({ catalog: swapped, coverage: { ...full, tables_total: 4, deadline_hit: true } })).toBe("kept_last_good");
    const r = await row();
    expect(r.catalog.tables!.map((t) => t.name)).toEqual(["users", "orders", "trips"]);
    expect(r.rescan_error).toMatch(/did not finish/);
    expect(r.rescan_attempts).toBe(3);
    expect(Date.parse(r.rescan_retry_at!) - Date.now()).toBeGreaterThan(3.5 * 3600_000);
  });

  it("a due retry is claimed once (leased), keyed on the failure time", async () => {
    const failedAt = (await row()).rescan_failed_at!;
    await svc.from("tenant_db_catalog").update({ rescan_retry_at: new Date(Date.now() - 60_000).toISOString() }).eq("tenant_id", tenantId);
    const first = (await svc.rpc("claim_db_rescan_retries", { p_limit: 1000 })).data as Array<{ tenant_id: string; failed_at: string }>;
    const mine = first.find((x) => x.tenant_id === tenantId);
    expect(mine && Date.parse(mine.failed_at)).toBe(Date.parse(failedAt));
    expect(Date.parse((await row()).rescan_retry_at!) - Date.now()).toBeGreaterThan(25 * 60_000);
    const again = (await svc.rpc("claim_db_rescan_retries", { p_limit: 1000 })).data as Array<{ tenant_id: string }>;
    expect(again.some((x) => x.tenant_id === tenantId)).toBe(false);
  });

  it("a complete scan replaces the catalog and clears the re-scan record", async () => {
    const bigger = { tables: [...good.tables, table("payments")] };
    expect(await apply({ catalog: bigger, coverage: { ...full, tables_total: 4, tables_indexed: 4 } })).toBe("stored");
    const r = await row();
    expect(r.catalog.tables).toHaveLength(4);
    expect(r).toMatchObject({ rescan_error: null, rescan_failed_at: null, rescan_attempts: 0, rescan_retry_at: null });
  });

  it("a scan capped by the table limit (listing_truncated, not out of time) replaces the catalog", async () => {
    const capped = { tables: [table("users"), table("orders"), table("trips"), table("payments")] };
    expect(await apply({ catalog: capped, coverage: { ...full, tables_total: 9, tables_indexed: 4, listing_truncated: true } })).toBe("stored");
    expect((await row()).catalog.tables).toHaveLength(4);
  });

  it("a stale scan writes nothing", async () => {
    const before = await row();
    expect(await apply({ error: "boom", generation: (await gen()) - 1 })).toBe("stale");
    expect(await row()).toEqual(before);
  });

  it("the old failure stamp records a re-scan failure on a catalog with tables, never discovery_error", async () => {
    const ok = await svc.rpc("stamp_tenant_db_discovery_error", { p_tenant_id: tenantId, p_error: "no_secret", p_generation: await gen() });
    expect(ok.data).toBe(true);
    const r = await row();
    expect(r).toMatchObject({ discovery_error: null, rescan_error: "no_secret", rescan_attempts: 1 });
    expect(Date.parse(r.rescan_retry_at!) - Date.now()).toBeGreaterThan(50 * 60_000);
    expect(r.catalog.tables).toHaveLength(4);
  });

  it("a policy-only change keeps the epoch; a source change moves it and the old catalog is never kept", async () => {
    const e0 = await epoch();
    await svc.from("tenant_db_config").update({ hidden_fields: ["users.id"] }).eq("tenant_id", tenantId);
    expect(await epoch()).toBe(e0);
    await svc.from("tenant_db_config").update({ connection_secret_key: "operator_db.connection_string.v2" }).eq("tenant_id", tenantId);
    expect(await epoch()).toBeGreaterThan(e0);
    expect(await apply({ error: "auth failed" })).toBe("stored_error");
    const r = await row();
    expect(r.catalog.tables ?? []).toHaveLength(0);
    expect(r.discovery_error).toBe("auth failed");
    expect(Number(r.source_epoch)).toBe(await epoch());
  });
});
