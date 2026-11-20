import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => {
  const sql = (fn: string, args: Record<string, unknown>) => {
    const keys = Object.keys(args);
    return { text: `select ${fn}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(",")}) as v`, values: keys.map((k) => args[k]) };
  };
  return {
    asTenantId: (t: string) => t,
    platformSecretRpc: async () => ({ data: null, error: { message: "unused" } }),
    tenantRpc: async (tid: string, fn: string, args: Record<string, unknown>) => {
      const q = sql(fn, { p_tenant_id: tid, ...args });
      try {
        return { data: (await db.query<{ v: unknown }>(q.text, q.values)).rows[0].v, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
    tenantClient: (tid: string) => ({
      from: (table: string) => ({
        select: (cols: string) => {
          const where: Array<[string, unknown]> = [["tenant_id", tid]];
          const q = {
            eq: (k: string, v: unknown) => (where.push([k, v]), q),
            then: (ok: (r: unknown) => unknown, bad?: (e: unknown) => unknown) =>
              db.query(`select ${cols} from ${table} where ${where.map(([k], i) => `${k}=$${i + 1}`).join(" and ")}`, where.map(([, v]) => v))
                .then((r) => ({ data: r.rows, error: null }), (e: Error) => ({ data: null, error: { message: e.message } }))
                .then(ok, bad),
          };
          return q;
        },
      }),
    }),
  };
});
vi.mock("@/services/connectors/linkedin-ads/client", () => ({ withLinkedInAdsToken: async (_t: string, fn: (token: string) => unknown) => fn("tok"), listLinkedInAdAccountsRaw: vi.fn() }));
vi.mock("../adapters/linkedin-account", () => ({ readLinkedinAccount: async () => ({ id: "508000111", currency: "USD" }), assertLinkedinCampaignRole: async () => undefined }));
vi.mock("@/services/connectors/linkedin-ads/http", () => ({ LINKEDIN_ADS_BILLING_HOLD: "", linkedinAdsGet: vi.fn(), linkedinOnBillingHold: () => false }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));

import { connectCustomerAccount, LINKEDIN_ACCOUNT_HELD_AFTER_DISCONNECT } from "../accounts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const ACCOUNT = "508000111";
let db: PGlite;
const migration = (file: string) => readFileSync(resolve("../../supabase/migrations", file), "utf8");
const row = async (sql: string, args: unknown[] = []) => (await db.query<Record<string, any>>(sql, args)).rows[0];
const register = (tenant: string, account = ACCOUNT, currency = "USD") =>
  row("select ads_register_customer_account($1,'linkedin',$2,$3,'linkedin_ads.access_token') as id", [tenant, account, currency]).then((r) => r.id as string);
const release = (tenant: string, account: string | null = null) =>
  row("select ads_release_customer_account_claim($1,'linkedin',$2) as n", [tenant, account]).then((r) => r.n as number);
const connect = (tenant: string) => db.query("insert into connector_metadata(tenant_id,slug,team_id) values ($1,'linkedin_ads','x') on conflict do nothing", [tenant]);
const disconnect = (tenant: string) => db.query("delete from connector_metadata where tenant_id=$1 and slug='linkedin_ads'", [tenant]);
const owner = () => row("select credential_tenant_id, claim_released_at from ads_provider_accounts where platform='linkedin' and provider_account_id=$1", [ACCOUNT]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role; create table tenants(id uuid primary key);");
  for (const f of [
    "20260924183000_chatgpt_ads_wallet.sql",
    "20260925083000_chatgpt_ads_wallet_controls.sql",
    "20260925120000_chatgpt_ads_resource_bindings.sql",
    "20260925121000_chatgpt_ads_daily_coverage.sql",
    "20261005100050_ads_wallet_creator_consent.sql",
    "20261017090000_chatgpt_ads_wallet_final_release.sql",
    "20261101161000_shared_ads_wallet_bindings.sql",
    "20261101162000_shared_ads_wallet_accounts.sql",
  ]) await db.exec(migration(f));
  await db.exec(`create schema vault; create table vault.secrets(id uuid primary key default gen_random_uuid(), secret text);
    create function vault.create_secret(value text) returns uuid language sql as $$ insert into vault.secrets(secret) values(value) returning id $$;
    create table public.secrets(tenant_id uuid references tenants(id) on delete cascade,key text,vault_secret_id uuid references vault.secrets(id),primary key(tenant_id,key));`);
  for (const f of [
    "20261101164000_chatgpt_customer_accounts.sql",
    "20261101165000_ads_resource_account_identity.sql",
    "20261102141800_ads_wallet_review_fixes.sql",
  ]) await db.exec(migration(f));
  await db.exec("create table connector_metadata(tenant_id uuid not null references tenants(id) on delete cascade, slug text not null, team_id text, primary key(tenant_id,slug));");
  await db.exec(`create table ad_budget_reservations (id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
    platform text not null, object_id text, status text not null, idem_key text not null)`);
  await db.exec(migration("20261121100500_linkedin_ads_release_account_claim.sql"));
  await db.exec(migration("20261121550100_linkedin_account_claim_held_after_disconnect.sql"));
}, 20_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("delete from ad_budget_reservations; delete from ads_campaign_operations; delete from ads_campaign_lifecycle; delete from connector_metadata; delete from ads_campaign_bindings; delete from ads_account_selections; delete from ads_account_binding_status; delete from ads_account_bindings; delete from ads_provider_accounts where legacy_key is null; delete from tenants;");
  await db.query("insert into tenants values ($1),($2)", [A, B]);
  await connect(A);
  await connect(B);
});

const holdMoney = async (binding: string) => {
  const campaign = (await row("select ads_bind_campaign($1,$2,'777001') as id", [A, binding])).id as string;
  await db.query("insert into ad_budget_reservations(tenant_id,platform,object_id,status,idem_key) values ($1,'linkedin',$2,'committed','x:resume')", [A, campaign]);
};

describe("picking a LinkedIn ad account another workspace still holds", () => {
  it("tenant: never takes the account over from a workspace that is still connected, and keeps the disconnect-there advice", async () => {
    await holdMoney(await register(A));
    await expect(register(B)).rejects.toThrow(/^account ownership conflict$/);
    await db.query("update ad_budget_reservations set status='released'");
    await expect(register(B)).rejects.toThrow(/^account ownership conflict$/);
    expect((await owner()).credential_tenant_id).toBe(A);
    await expect(connectCustomerAccount(B, "linkedin", ACCOUNT, false)).rejects.toMatchObject({
      code: "ads_account_owned_elsewhere",
      message: expect.stringMatching(/disconnect it from the other workspace/),
    });
  });

  it("when the holder already disconnected but still has money on the account, says to contact support, never to disconnect there, and moves nothing", async () => {
    await holdMoney(await register(A));
    await disconnect(A);
    await expect(register(B)).rejects.toThrow(/^account claim held after disconnect$/);
    expect((await owner()).credential_tenant_id).toBe(A);
    const err = await connectCustomerAccount(B, "linkedin", ACCOUNT, false).catch((e) => e);
    expect(err).toMatchObject({ code: "ads_account_owned_elsewhere", message: LINKEDIN_ACCOUNT_HELD_AFTER_DISCONNECT });
    expect(err.message).toMatch(/Contact Zavi support/);
    expect(err.message).not.toMatch(/disconnect it/i);
    expect((await row("select count(*)::int as n from ads_account_bindings where tenant_id=$1", [B])).n).toBe(0);
  });

  it("when the holder disconnected and has nothing running there, the account moves to the new workspace", async () => {
    await register(A);
    await disconnect(A);
    expect(await connectCustomerAccount(B, "linkedin", ACCOUNT, false)).toEqual(expect.any(String));
    expect((await owner()).credential_tenant_id).toBe(B);
  });

  it("a different currency is still an ownership conflict, not the disconnected-holder message", async () => {
    await holdMoney(await register(A));
    await disconnect(A);
    await expect(register(B, ACCOUNT, "EUR")).rejects.toThrow(/^account ownership conflict$/);
  });
});
