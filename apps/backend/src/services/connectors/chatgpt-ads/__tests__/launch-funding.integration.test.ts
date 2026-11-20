import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ db: null as any, campaign: {} as any }));
const tenant = "00000000-0000-4000-8000-000000000001";
vi.mock("../workspace", () => ({
  readCampaignTree: async () => ({ campaign: m.campaign, groups: [], ads: [] }),
  readCampaign: vi.fn(), updateCampaign: vi.fn(), updateAdStatus: vi.fn(), updateGroupStatus: vi.fn(),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantClient: (tid: string) => ({ from: () => {
    let campaignId = "";
    const q: any = { select: () => q, eq: (_key: string, value: string) => { campaignId = value; return q; },
      maybeSingle: async () => ({ data: (await m.db.query("select * from ads_campaign_funding where tenant_id=$1 and campaign_id=$2", [tid, campaignId])).rows[0] ?? null, error: null }) };
    return q;
  } }),
}));
vi.mock("@/services/channels/chatgpt-ads/wallet", () => ({ readWallet: async (tid: string) => {
  const row = (await m.db.query("select balance_cents - (select coalesce(sum(reserved_cents),0) from ads_campaign_funding where tenant_id=$1) as available from ads_wallets where tenant_id=$1", [tid])).rows[0];
  return { currency: "USD", available_cents: Number(row.available), funding_enabled: true, in_app_enabled: true };
} }));
import { readLaunchSummary } from "../launch";
const modules = process.env.ADS_SQL_TEST_MODULES;
describe("launch funding preview versus real reservation SQL", () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(modules ? resolve(modules, "../package.json") : resolve("package.json"))("@electric-sql/pglite");
    m.db = new PGlite();
    await m.db.exec("create role anon; create role authenticated; create role service_role; create table tenants(id uuid primary key);");
    for (const file of ["20260924183000_chatgpt_ads_wallet.sql", "20260925121000_chatgpt_ads_daily_coverage.sql"]) {
      await m.db.exec(readFileSync(resolve("../../supabase/migrations", file), "utf8"));
    }
  });
  afterAll(async () => { await m.db?.close(); });
  beforeEach(async () => {
    await m.db.exec("truncate tenants cascade");
    await m.db.query("insert into tenants values ($1)", [tenant]);
    await m.db.query("insert into ads_wallets(tenant_id,balance_cents) values ($1,0)", [tenant]);
    const start = Math.floor(Date.now() / 1000);
    m.campaign = { id: "c1", name: "zv-acme--test", status: "paused", updated_at: start, start_time: start, end_time: start + 2 * 86400, budget: { daily_spend_limit_micros: 25_000_000 } };
  });
  async function reserve(spent = 0) {
    const c = m.campaign;
    return m.db.query("select ads_wallet_reserve_daily($1,'c1',$2,$3,$4,$5)", [tenant, c.budget.daily_spend_limit_micros, Math.min(c.start_time, c.created_at ?? c.start_time), c.end_time, spent]);
  }
  async function balance(cents: number) { await m.db.query("update ads_wallets set balance_cents=$2 where tenant_id=$1", [tenant, cents]); }
  it("adding exactly the displayed shortfall makes the daily reserve possible", async () => {
    await balance(1282);
    expect((await readLaunchSummary(tenant, "c1")).shortfall_cents).toBe(18718);
    await expect(reserve()).rejects.toThrow("ads_balance_insufficient");
    await balance(19999);
    await expect(reserve()).rejects.toThrow("ads_balance_insufficient");
    await balance(20000);
    await reserve();
    expect((await readLaunchSummary(tenant, "c1")).shortfall_cents).toBe(0);
  });
  it("a funded campaign with zero free balance needs no arbitrary $10 top-up", async () => {
    await balance(20000); await reserve();
    expect((await readLaunchSummary(tenant, "c1")).shortfall_cents).toBe(0);
    await expect(reserve()).resolves.toBeDefined();
  });
  it("retained higher daily coverage is used after final release and a smaller restart", async () => {
    await balance(50000);
    m.campaign.budget.daily_spend_limit_micros = 50_000_000;
    await reserve();
    await m.db.query("update ads_campaign_funding set reserved_cents=0 where tenant_id=$1", [tenant]);
    await balance(10000);
    m.campaign.budget.daily_spend_limit_micros = 25_000_000;
    m.campaign.end_time -= 86400;
    expect((await readLaunchSummary(tenant, "c1")).shortfall_cents).toBe(30000);
    await expect(reserve()).rejects.toThrow("ads_balance_insufficient");
    await balance(40000); await reserve();
  });
  it("a refund producing negative available funds is shown and refused", async () => {
    await balance(20000); await reserve(); await balance(19500);
    expect((await readLaunchSummary(tenant, "c1")).shortfall_cents).toBe(500);
    await expect(reserve()).rejects.toThrow("ads_balance_insufficient");
  });
  it("creation before the scheduled start is included in conservative coverage", async () => {
    m.campaign.created_at = m.campaign.start_time - 86400;
    expect((await readLaunchSummary(tenant, "c1")).shortfall_cents).toBe(25000);
    await balance(25000); await reserve();
  });
});
