import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const m = vi.hoisted(() => ({ db: null as any, intent: null as any, disputes: [] as any[], refundStatus: "succeeded" }));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: async () => ({ allowed: true }) }));
vi.mock("@/services/channels/lock", () => ({ isChannelLocked: async () => false }));
vi.mock("@/services/ads-wallet/stripe-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ads-wallet/stripe-client")>();
  const s = { refunds: { list: async () => ({ data: [{ id: "re1", currency: "usd", amount: m.intent.latest_charge.amount_refunded, status: m.refundStatus }], has_more: false }) }, paymentIntents: { retrieve: async () => m.intent }, disputes: { list: async () => ({ data: m.disputes, has_more: false }) } };
  return { ...actual, adsStripe: () => s, requireAdsStripe: () => s };
});
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({
  from(table: string) {
    let columns = "*", update: Record<string, unknown> | undefined;
    const filters: Array<[string, unknown, "eq" | "in"]> = [];
    const q: any = {
      select: (value: string) => { columns = value; return q; },
      eq: (key: string, value: unknown) => { filters.push([key, value, "eq"]); return q; },
      in: (key: string, value: unknown[]) => { filters.push([key, value, "in"]); return q; },
      update: (value: Record<string, unknown>) => { update = value; return q; },
      upsert: async () => ({ error: null }),
      single: async () => { const r = await run(); return { data: r.rows[0] ?? null, error: null }; },
      then: (done: (v: unknown) => unknown, fail: (e: unknown) => unknown) => run().then((r: any) => done({ data: r.rows, error: null }), fail),
    };
    const run = () => {
      const values: unknown[] = [];
      const arg = (v: unknown) => { values.push(v); return `$${values.length}`; };
      const prefix = update ? `update ${table} set ${Object.entries(update).map(([k,v]) => `${k}=${arg(v)}`).join(",")}` : `select ${columns} from ${table}`;
      const where = filters.map(([k,v,op]) => op === "in" ? `${k} = any(${arg(v)})` : `${k}=${arg(v)}`).join(" and ");
      return m.db.query(`${prefix} where ${where}`, values);
    };
    return q;
  },
  async rpc(name: string, args: Record<string, unknown>) {
    try {
      await m.db.query(`select ${name}(${Object.keys(args).map((k,i) => `${k} => $${i+1}`).join(",")})`, Object.values(args));
      return { data: null, error: null };
    } catch (error) { return { data: null, error }; }
  },
}) }));
import { stripeAdsWebhook } from "@/routes/webhooks/stripe-ads";
const tenant = "00000000-0000-4000-8000-000000000001";
const order = "10000000-0000-4000-8000-000000000001";
const secret = "whsec_isolated_contract_test";
const sdk = new Stripe("sk_test_isolated");
const modules = process.env.ADS_SQL_TEST_MODULES;
describe("signed ads webhook through the real wallet and SQL ledger", () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(modules ? resolve(modules, "../package.json") : resolve("package.json"))("@electric-sql/pglite");
    m.db = new PGlite();
    await m.db.exec("create role anon; create role authenticated; create role service_role; create table tenants(id uuid primary key);");
    for (const file of ["20260924183000_chatgpt_ads_wallet.sql", "20260925083000_chatgpt_ads_wallet_controls.sql", "20260925120000_chatgpt_ads_resource_bindings.sql", "20260925121000_chatgpt_ads_daily_coverage.sql", "20261005100050_ads_wallet_creator_consent.sql", "20261017090000_chatgpt_ads_wallet_final_release.sql", "20261101161000_shared_ads_wallet_bindings.sql"]) await m.db.exec(readFileSync(resolve("../../supabase/migrations", file), "utf8"));
    vi.stubEnv("STRIPE_ADS_SECRET_KEY", ""); vi.stubEnv("STRIPE_PLATFORM_SECRET_KEY", "sk_test_isolated"); vi.stubEnv("STRIPE_ADS_WEBHOOK_SECRET", secret);
  });
  afterAll(async () => { await m.db?.close(); vi.unstubAllEnvs(); });
  beforeEach(async () => {
    await m.db.exec("delete from tenants");
    await m.db.query("insert into tenants values ($1)", [tenant]);
    await m.db.query("insert into ads_wallets(tenant_id,stripe_customer_id,payment_method_id,auto_refill_enabled) values ($1,'cus1','pm1',true)", [tenant]);
    await m.db.query("insert into ads_wallet_orders(id,tenant_id,kind,amount_cents) values ($1,$2,'topup',10000)", [order,tenant]);
    m.intent = { id: "pi1", customer: "cus1", status: "succeeded", currency: "usd", amount: 10000, amount_received: 10000, metadata: { kind: "chatgpt_ads_wallet", order_id: order }, latest_charge: { id: "ch1", amount_refunded: 0, disputed: false } };
    m.disputes = []; m.refundStatus = "succeeded";
  });
  async function send(type: string, created: number, valid = true) {
    const payload = JSON.stringify({ id: `evt_${created}`, object: "event", livemode: false, type, created, data: { object: type === "payment_intent.succeeded" ? { id: "pi1" } : { payment_intent: "pi1" } } });
    const signature = sdk.webhooks.generateTestHeaderString({ payload, secret: valid ? secret : "wrong" });
    const req = { body: Buffer.from(payload), header: () => signature } as unknown as Request;
    const res = { status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res);
    await stripeAdsWebhook(req, res as unknown as Response);
    return res;
  }
  it("retains the highest daily bid and widest schedule across budget edits", async () => {
    await m.db.query("update ads_wallets set balance_cents=1000000 where tenant_id=$1",[tenant]);
    const start=1800000000, end=start+86400*3;
    await m.db.query("select ads_wallet_reserve_daily($1,'daily',100000000,$2,$3,0)",[tenant,start,end]);
    let f=(await m.db.query("select * from ads_campaign_funding where campaign_id='daily'")).rows[0];
    expect(Number(f.reserved_cents)).toBe(100000);
    await m.db.query("select ads_wallet_settle_spend($1,'daily',80000)",[tenant]);
    await m.db.query("select ads_wallet_reserve_daily($1,'daily',25000000,$2,$3,80000)",[tenant,start,end+86400*7]);
    f=(await m.db.query("select * from ads_campaign_funding where campaign_id='daily'")).rows[0];
    expect(Number(f.daily_max_micros)).toBe(100000000);
    expect(Number(f.reserved_cents)).toBe(160000);
  });
  it("rejects underfunded daily activation atomically and keeps other campaign coverage", async () => {
    await m.db.query("update ads_wallets set balance_cents=10000 where tenant_id=$1",[tenant]);
    await m.db.query("select ads_wallet_reserve($1,'existing',8000,0)",[tenant]);
    await expect(m.db.query("select ads_wallet_reserve_daily($1,'daily',25000000,1800000000,1800086400,0)",[tenant])).rejects.toThrow("ads_balance_insufficient");
    const rows=(await m.db.query("select * from ads_campaign_funding")).rows;
    expect(rows).toHaveLength(1); expect(Number(rows[0].reserved_cents)).toBe(8000);
  });
  it("cannot assign two clients to the same conversion source", async () => {
    const other="00000000-0000-4000-8000-000000000002";
    await m.db.query("insert into tenants values ($1)",[other]);
    await m.db.query("insert into ads_conversion_sources values ('source1',$1)",[tenant]);
    await m.db.query("insert into ads_resource_bindings(resource_id,tenant_id,kind,source_id) values ('event1',$1,'conversion_event','source1')",[tenant]);
    await expect(m.db.query("insert into ads_resource_bindings(resource_id,tenant_id,kind,source_id) values ('event2',$1,'conversion_event','source1')",[other])).rejects.toThrow(/foreign key/);
    await m.db.query("delete from tenants where id=$1",[tenant]);
    expect((await m.db.query("select * from ads_resource_bindings")).rows).toHaveLength(0);
  });
  it("denies browser roles access to bindings and daily reservation RPC", async () => {
    await m.db.exec("set role authenticated");
    await expect(m.db.query("select * from ads_resource_bindings")).rejects.toThrow(/permission denied/);
    await expect(m.db.query("select ads_wallet_reserve_daily($1,'c',25000000,1800000000,1800086400,0)",[tenant])).rejects.toThrow(/permission denied/);
    await m.db.exec("reset role");
  });
  const wallet = async () => (await m.db.query("select * from ads_wallets where tenant_id=$1", [tenant])).rows[0];
  it("$100 payment then $10 dispute credits $90, disables refill and is replay safe", async () => {
    expect((await send("payment_intent.succeeded", 100)).json).toHaveBeenCalledWith({ ok: true });
    m.intent.latest_charge.disputed = true;
    m.disputes = [{ id: "dp1", amount: 1000, currency: "usd", status: "needs_response" }];
    expect((await send("charge.dispute.created", 200)).json).toHaveBeenCalledWith({ ok: true });
    await send("charge.dispute.created", 200);
    expect(Number((await wallet()).balance_cents)).toBe(9000);
    expect((await wallet()).auto_refill_enabled).toBe(false);
  });
  it("a paid top-up clears only the refill errors it resolves", async () => {
    const { REFILL_DECLINED_MESSAGE } = await import("@/services/ads-wallet/wallet");
    await m.db.query("update ads_wallets set last_error=$2 where tenant_id=$1", [tenant, REFILL_DECLINED_MESSAGE]);
    expect((await send("payment_intent.succeeded", 100)).json).toHaveBeenCalledWith({ ok: true });
    expect((await wallet()).last_error).toBeNull();
    const cap = "The $1,000 daily auto-refill limit has been reached. Automatic refills resume after midnight UTC.";
    const second = "20000000-0000-4000-8000-000000000002";
    await m.db.query("insert into ads_wallet_orders(id,tenant_id,kind,amount_cents) values ($1,$2,'topup',5000)", [second, tenant]);
    await m.db.query("update ads_wallets set last_error=$2 where tenant_id=$1", [tenant, cap]);
    m.intent = { ...m.intent, id: "pi2", amount: 5000, amount_received: 5000, metadata: { ...m.intent.metadata, order_id: second } };
    expect((await send("payment_intent.succeeded", 300)).json).toHaveBeenCalledWith({ ok: true });
    expect((await wallet()).last_error).toBe(cap);
  });
  it("refunds after $80 spend produce -$80 and no refill claim", async () => {
    await send("payment_intent.succeeded", 100);
    await m.db.query("select ads_wallet_reserve($1,'c1',8000,0)", [tenant]);
    await m.db.query("select ads_wallet_settle_spend($1,'c1',8000)", [tenant]);
    m.intent.latest_charge.amount_refunded = 10000;
    expect((await send("charge.refunded", 200)).json).toHaveBeenCalledWith({ ok: true });
    expect(Number((await wallet()).balance_cents)).toBe(-8000);
    expect((await wallet()).auto_refill_enabled).toBe(false);
    expect((await m.db.query("select ads_wallet_claim_refill($1) as id", [tenant])).rows[0].id).toBeNull();
    await send("payment_intent.succeeded", 100);
    expect(Number((await wallet()).balance_cents)).toBe(-8000);
  });
  it("a failed refund restores credit once and leaves automatic charges off", async () => {
    await send("payment_intent.succeeded", 100);
    m.intent.latest_charge.amount_refunded = 10000; m.refundStatus = "pending";
    await send("refund.created", 200);
    expect(Number((await wallet()).balance_cents)).toBe(0);
    m.refundStatus = "failed";
    expect((await send("refund.failed", 300)).json).toHaveBeenCalledWith({ ok: true });
    await send("refund.failed", 300);
    expect(Number((await wallet()).balance_cents)).toBe(10000);
    expect((await wallet()).auto_refill_enabled).toBe(false);
  });
  it("invalid signature cannot credit the SQL ledger", async () => {
    expect((await send("payment_intent.succeeded", 100, false)).status).toHaveBeenCalledWith(400);
    expect(Number((await wallet()).balance_cents)).toBe(0);
  });
});
